/**
 * Resolve quoted file messages via DingTalk group-file storage APIs.
 *
 * Five-step chain:
 *   senderStaffId → unionId
 *   conversationId + unionId → spaceId
 *   spaceId + createdAt±10s → dentryId (scan up to 3 pages)
 *   spaceId + dentryId → resourceUrl (signed CDN)
 *   download resourceUrl → local temp file
 */

import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDingTalkAccessToken } from "./api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedQuotedFile {
  media: { path: string; mimeType: string };
  spaceId: string;
  fileId: string;
  name?: string;
}

interface ResolveParams {
  openConversationId: string;
  senderStaffId?: string;
  fileCreatedAt?: number;   // ms timestamp
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DINGTALK_API = "https://api.dingtalk.com/v1.0";
const DINGTALK_OAPI = "https://oapi.dingtalk.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 3;
const TIME_TOLERANCE_MS = 10_000;  // ±10 s for createdAt matching
const TEMP_DIR = path.join(os.tmpdir(), "dingtalk-media");

// ---------------------------------------------------------------------------
// LRU caches (in-memory only)
// ---------------------------------------------------------------------------

/** staffId → unionId */
const unionIdCache = new Map<string, string>();
const UNION_CACHE_MAX = 5000;

/** conversationId:unionId → spaceId */
const spaceIdCache = new Map<string, string>();
const SPACE_CACHE_MAX = 500;

function lruSet<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  if (map.size >= max) {
    // Delete first (oldest) entry
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, value);
}

// ---------------------------------------------------------------------------
// HTTP helpers (mirrors api.ts internals — those aren't exported)
// ---------------------------------------------------------------------------

function jsonPost(url: string, body: any, headers?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(urlObj, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)), ...headers },
      timeout: 15_000,
      family: 4,
    }, (res) => {
      let buf = "";
      res.on("data", (c: any) => { buf += c; });
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(data);
    req.end();
  });
}

function jsonGet(url: string, headers?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(urlObj, {
      method: "GET",
      headers: { ...headers },
      timeout: 15_000,
      family: 4,
    }, (res) => {
      let buf = "";
      res.on("data", (c: any) => { buf += c; });
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

function downloadBuffer(url: string, headers?: Record<string, string>, forceIPv4 = false): Promise<{ buffer: Buffer; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const opts: https.RequestOptions = {
      method: "GET",
      headers: headers || {},
      timeout: 60_000,
    };
    if (forceIPv4) opts.family = 4;
    const req = mod.request(urlObj, opts, (res) => {
      // Follow redirects (3xx)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBuffer(res.headers.location, headers, forceIPv4).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => { chunks.push(c); });
      res.on("end", () => { resolve({ buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] }); });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timeout")); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Step 1: staffId → unionId
// ---------------------------------------------------------------------------

async function getUnionId(
  clientId: string, clientSecret: string, staffId: string, log?: any,
): Promise<string | null> {
  const cached = unionIdCache.get(staffId);
  if (cached) return cached;

  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const res = await jsonPost(
      `${DINGTALK_OAPI}/topapi/v2/user/get?access_token=${token}`,
      { userid: staffId, language: "zh_CN" },
    );
    if (res.errcode !== 0 || !res.result?.unionid) {
      log?.warn?.(`[dingtalk][quoted-file] Failed to get unionId for ${staffId}: ${res.errmsg || JSON.stringify(res)}`);
      return null;
    }
    const unionId = res.result.unionid as string;
    lruSet(unionIdCache, staffId, unionId, UNION_CACHE_MAX);
    return unionId;
  } catch (err) {
    log?.warn?.(`[dingtalk][quoted-file] getUnionId error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2: conversationId + unionId → spaceId
// ---------------------------------------------------------------------------

async function getSpaceId(
  clientId: string, clientSecret: string,
  openConversationId: string, unionId: string, log?: any,
): Promise<string | null> {
  const cacheKey = `${openConversationId}:${unionId}`;
  const cached = spaceIdCache.get(cacheKey);
  if (cached) return cached;

  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const res = await jsonPost(
      `${DINGTALK_API}/convFile/conversations/spaces/query`,
      { openConversationId, unionId },
      { "x-acs-dingtalk-access-token": token },
    );
    if (!res.spaceId) {
      log?.warn?.(`[dingtalk][quoted-file] Failed to get spaceId for conv=${openConversationId}: ${JSON.stringify(res).substring(0, 300)}`);
      return null;
    }
    const spaceId = String(res.spaceId);
    lruSet(spaceIdCache, cacheKey, spaceId, SPACE_CACHE_MAX);
    return spaceId;
  } catch (err) {
    log?.warn?.(`[dingtalk][quoted-file] getSpaceId error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 3: spaceId + createdAt → dentryId (list entries, match by time)
// ---------------------------------------------------------------------------

async function findDentryByTime(
  clientId: string, clientSecret: string,
  spaceId: string, createdAt: number, log?: any,
): Promise<{ dentryId: string; name?: string } | null> {
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };

    let nextToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${DINGTALK_API}/storage/spaces/${spaceId}/dentries/listAll`);
      url.searchParams.set("maxResults", String(PAGE_SIZE));
      url.searchParams.set("orderType", "modifiedTimeDesc");
      if (nextToken) url.searchParams.set("nextToken", nextToken);

      const res = await jsonGet(url.toString(), headers);

      const items: any[] = res.items || res.dentries || [];
      for (const item of items) {
        const itemTime = item.createdTime ? new Date(item.createdTime).getTime()
                       : (item.createTime ?? 0);
        if (Math.abs(itemTime - createdAt) <= TIME_TOLERANCE_MS) {
          const dentryId = item.dentryId || item.id;
          if (dentryId) {
            log?.info?.(`[dingtalk][quoted-file] Matched dentry by time: id=${dentryId} name=${item.name}`);
            return { dentryId: String(dentryId), name: item.name };
          }
        }
      }

      nextToken = res.nextToken;
      if (!nextToken || items.length < PAGE_SIZE) break;
    }

    log?.warn?.(`[dingtalk][quoted-file] No dentry matched createdAt=${createdAt} in spaceId=${spaceId}`);
    return null;
  } catch (err) {
    log?.warn?.(`[dingtalk][quoted-file] findDentryByTime error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 4: spaceId + dentryId → resourceUrl
// ---------------------------------------------------------------------------

async function getDownloadUrl(
  clientId: string, clientSecret: string,
  spaceId: string, dentryId: string, log?: any,
): Promise<{ url: string; headers?: Record<string, string> } | null> {
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const res = await jsonPost(
      `${DINGTALK_API}/storage/spaces/${spaceId}/dentries/${dentryId}/downloadInfos/query`,
      {},
      { "x-acs-dingtalk-access-token": token },
    );

    const info = res.downloadInfo || res;
    const resourceUrl = info.resourceUrl || info.url;
    if (!resourceUrl) {
      log?.warn?.(`[dingtalk][quoted-file] No resourceUrl for dentry=${dentryId}: ${JSON.stringify(res).substring(0, 300)}`);
      return null;
    }

    // Collect signed headers if any
    const signedHeaders: Record<string, string> = {};
    const headerEntries = info.headers || info.headerSignatureInfos;
    if (Array.isArray(headerEntries)) {
      for (const h of headerEntries) {
        if (h.headerName && h.headerValue) {
          signedHeaders[h.headerName] = h.headerValue;
        } else if (h.name && h.value) {
          signedHeaders[h.name] = h.value;
        }
      }
    } else if (headerEntries && typeof headerEntries === "object") {
      Object.assign(signedHeaders, headerEntries);
    }

    return { url: resourceUrl, headers: Object.keys(signedHeaders).length > 0 ? signedHeaders : undefined };
  } catch (err) {
    log?.warn?.(`[dingtalk][quoted-file] getDownloadUrl error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 5: download to temp file
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".rar": "application/x-rar-compressed",
  ".7z": "application/x-7z-compressed",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".amr": "audio/amr",
  ".m4a": "audio/mp4",
};

async function downloadToTemp(
  resourceUrl: string, signedHeaders?: Record<string, string>,
  name?: string, log?: any,
): Promise<{ path: string; mimeType: string } | null> {
  try {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    let result: { buffer: Buffer; contentType?: string };
    try {
      result = await downloadBuffer(resourceUrl, signedHeaders);
    } catch {
      // Retry with IPv4-only
      log?.info?.("[dingtalk][quoted-file] CDN download failed, retrying IPv4-only");
      result = await downloadBuffer(resourceUrl, signedHeaders, true);
    }

    const ext = name ? path.extname(name).toLowerCase() : "";
    const mimeType = result.contentType?.split(";")[0]?.trim()
                  || MIME_BY_EXT[ext]
                  || "application/octet-stream";

    let filename: string;
    if (name && path.extname(name)) {
      const base = path.basename(name, path.extname(name)).replace(/[^\w\u4e00-\u9fa5.-]/g, "_").slice(0, 60);
      filename = `${base}_${Date.now()}${path.extname(name)}`;
    } else {
      filename = `quoted_file_${Date.now()}${ext || ".bin"}`;
    }

    const filePath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(filePath, result.buffer);

    log?.info?.(`[dingtalk][quoted-file] Downloaded ${filePath} (${result.buffer.length} bytes, ${mimeType})`);
    return { path: filePath, mimeType };
  } catch (err) {
    log?.warn?.(`[dingtalk][quoted-file] Download failed: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function resolveQuotedFile(
  config: { clientId?: string; clientSecret?: string },
  params: ResolveParams,
  log?: any,
): Promise<ResolvedQuotedFile | null> {
  const { clientId, clientSecret } = config;
  if (!clientId || !clientSecret) return null;

  const { openConversationId, senderStaffId, fileCreatedAt } = params;
  if (!openConversationId || !senderStaffId || !fileCreatedAt) {
    log?.warn?.("[dingtalk][quoted-file] Missing required params: conv=" + openConversationId + " sender=" + senderStaffId + " ts=" + fileCreatedAt);
    return null;
  }

  // Step 1: staffId → unionId
  const unionId = await getUnionId(clientId, clientSecret, senderStaffId, log);
  if (!unionId) return null;

  // Step 2: conversationId + unionId → spaceId
  const spaceId = await getSpaceId(clientId, clientSecret, openConversationId, unionId, log);
  if (!spaceId) return null;

  // Step 3: list dentries, match by time
  const dentry = await findDentryByTime(clientId, clientSecret, spaceId, fileCreatedAt, log);
  if (!dentry) return null;

  // Step 4: get download URL
  const dlInfo = await getDownloadUrl(clientId, clientSecret, spaceId, dentry.dentryId, log);
  if (!dlInfo) return null;

  // Step 5: download to temp
  const media = await downloadToTemp(dlInfo.url, dlInfo.headers, dentry.name, log);
  if (!media) return null;

  return {
    media,
    spaceId,
    fileId: dentry.dentryId,
    name: dentry.name,
  };
}
