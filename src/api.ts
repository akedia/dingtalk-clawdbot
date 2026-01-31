import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DINGTALK_API_BASE = "https://api.dingtalk.com/v1.0";
const DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";

/** Temp directory for downloaded media files */
const TEMP_DIR = path.join(os.tmpdir(), "dingtalk-media");

/** Cache access tokens per clientId */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function jsonPost(url: string, body: any, headers?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(urlObj, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
      timeout: 10000, // 10 second timeout
      family: 4, // Force IPv4 to avoid IPv6 connection issues
    }, (res) => {
      let buf = "";
      res.on("data", (chunk: any) => { buf += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve({ raw: buf }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.write(data);
    req.end();
  });
}

function httpGetBuffer(url: string, headers?: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(urlObj, {
      method: "GET",
      headers: headers || {},
      timeout: 30000, // 30 second timeout for file downloads
      family: 4,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      res.on("end", () => {
        resolve(Buffer.concat(chunks));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Download timeout"));
    });
    req.end();
  });
}

/** Retry wrapper for async functions */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000,
  backoffMultiplier: number = 2,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = delayMs * Math.pow(backoffMultiplier, attempt - 1);
        console.log(`[dingtalk] Retry ${attempt}/${maxRetries} after ${delay}ms: ${lastError.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

export async function getDingTalkAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const res = await jsonPost(`${DINGTALK_API_BASE}/oauth2/accessToken`, {
    appKey: clientId,
    appSecret: clientSecret,
  });
  if (!res.accessToken) {
    throw new Error(`DingTalk token error: ${JSON.stringify(res)}`);
  }
  tokenCache.set(clientId, {
    token: res.accessToken,
    expiresAt: Date.now() + (res.expireIn ?? 7200) * 1000,
  });
  return res.accessToken;
}

/** Send reply via sessionWebhook (preferred, no auth needed) */
export async function sendViaSessionWebhook(
  sessionWebhook: string,
  text: string,
): Promise<{ ok: boolean; errcode?: number; errmsg?: string }> {
  const res = await jsonPost(sessionWebhook, {
    msgtype: "text",
    text: { content: text },
  });
  const ok = res?.errcode === 0 || !res?.errcode;
  if (!ok) {
    console.warn(`[dingtalk] SessionWebhook text error: errcode=${res?.errcode}, errmsg=${res?.errmsg}`);
  }
  return { ok, errcode: res?.errcode, errmsg: res?.errmsg };
}

/** Send markdown via sessionWebhook */
export async function sendMarkdownViaSessionWebhook(
  sessionWebhook: string,
  title: string,
  text: string,
): Promise<{ ok: boolean; errcode?: number; errmsg?: string }> {
  const res = await jsonPost(sessionWebhook, {
    msgtype: "markdown",
    markdown: { title, text },
  });
  const ok = res?.errcode === 0 || !res?.errcode;
  if (!ok) {
    console.warn(`[dingtalk] SessionWebhook markdown error: errcode=${res?.errcode}, errmsg=${res?.errmsg}`);
  }
  return { ok, errcode: res?.errcode, errmsg: res?.errmsg };
}

/** Send image via sessionWebhook using markdown format */
export async function sendImageViaSessionWebhook(
  sessionWebhook: string,
  imageUrl: string,
  caption?: string,
): Promise<{ ok: boolean }> {
  const title = caption || "图片";
  const text = caption
    ? `${caption}\n\n![image](${imageUrl})`
    : `![image](${imageUrl})`;

  return sendMarkdownViaSessionWebhook(sessionWebhook, title, text);
}

/** Send message via REST API (proactive/outbound, requires token) */
export async function sendDingTalkRestMessage(params: {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  userId?: string;
  conversationId?: string;
  text: string;
  format?: 'text' | 'markdown';
}): Promise<{ ok: boolean }> {
  const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
  const headers = { "x-acs-dingtalk-access-token": token };

  // Use markdown format by default for better rendering
  const useMarkdown = params.format !== 'text';
  const msgKey = useMarkdown ? 'sampleMarkdown' : 'sampleText';
  const msgParam = useMarkdown
    ? JSON.stringify({ title: 'AI', text: params.text })
    : JSON.stringify({ content: params.text });

  if (params.userId) {
    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/oToMessages/batchSend`,
      {
        robotCode: params.robotCode,
        userIds: [params.userId],
        msgKey,
        msgParam,
      },
      headers,
    );
    if (res?.errcode && res.errcode !== 0) {
      throw new Error(`DingTalk DM send error: ${JSON.stringify(res)}`);
    }
    return { ok: !!res?.processQueryKey || !res?.code };
  }

  if (params.conversationId) {
    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/groupMessages/send`,
      {
        robotCode: params.robotCode,
        openConversationId: params.conversationId,
        msgKey,
        msgParam,
      },
      headers,
    );
    if (res?.errcode && res.errcode !== 0) {
      throw new Error(`DingTalk group send error: ${JSON.stringify(res)}`);
    }
    return { ok: !!res?.processQueryKey || !res?.code };
  }

  throw new Error("Either userId or conversationId required");
}

/** Probe DingTalk connection by getting an access token */
export async function probeDingTalk(
  clientId: string,
  clientSecret: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await getDingTalkAccessToken(clientId, clientSecret);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** User info cache - persisted to local file */
const USER_CACHE_FILE = path.join(os.homedir(), ".clawdbot", "extensions", "dingtalk", ".cache", "users.json");
let userCache: Map<string, { name: string; avatar?: string }> | null = null;

function loadUserCache(): Map<string, { name: string; avatar?: string }> {
  if (userCache) return userCache;

  try {
    if (fs.existsSync(USER_CACHE_FILE)) {
      const data = fs.readFileSync(USER_CACHE_FILE, "utf-8");
      const obj = JSON.parse(data);
      userCache = new Map(Object.entries(obj));
      return userCache;
    }
  } catch (err) {
    console.warn("[dingtalk] Failed to load user cache:", err);
  }

  userCache = new Map();
  return userCache;
}

function saveUserCache(cache: Map<string, { name: string; avatar?: string }>): void {
  try {
    const dir = path.dirname(USER_CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj = Object.fromEntries(cache.entries());
    fs.writeFileSync(USER_CACHE_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch (err) {
    console.warn("[dingtalk] Failed to save user cache:", err);
  }
}

/** Get user info by userid (staffId), with persistent cache */
export async function getUserInfo(
  clientId: string,
  clientSecret: string,
  userid: string,
): Promise<{ name: string; avatar?: string } | null> {
  const cache = loadUserCache();

  // Check cache first
  const cached = cache.get(userid);
  if (cached) return cached;

  // Call DingTalk API
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const res = await jsonPost(
      `${DINGTALK_OAPI_BASE}/topapi/v2/user/get?access_token=${token}`,
      {
        userid,
        language: "zh_CN",
      },
    );

    if (res.errcode !== 0) {
      console.warn(`[dingtalk] Failed to get user info for ${userid}: ${res.errmsg}`);
      return null;
    }

    const userInfo = {
      name: res.result?.name || userid,
      avatar: res.result?.avatar,
    };

    // Save to cache
    cache.set(userid, userInfo);
    saveUserCache(cache);

    return userInfo;
  } catch (err) {
    console.warn(`[dingtalk] Error getting user info for ${userid}:`, err);
    return null;
  }
}

/** Batch get user info with timeout */
export async function batchGetUserInfo(
  clientId: string,
  clientSecret: string,
  userids: string[],
  timeoutMs: number = 500,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  if (userids.length === 0) return result;

  const promises = userids.map(async (userid) => {
    const info = await getUserInfo(clientId, clientSecret, userid);
    if (info) {
      result.set(userid, info.name);
    }
  });

  try {
    await Promise.race([
      Promise.all(promises),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
  } catch (err) {
    // Timeout or error - return partial results
    console.warn(`[dingtalk] Batch user info fetch timeout/error:`, err);
  }

  return result;
}

/** Download picture from DingTalk and return as base64 or file path */
export async function downloadPicture(
  clientId: string,
  clientSecret: string,
  robotCode: string,
  downloadCode: string,
): Promise<{ base64?: string; filePath?: string; error?: string }> {
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);

    // DingTalk picture download API (v1.0 API, NOT oapi)
    const url = `${DINGTALK_API_BASE}/robot/messageFiles/download`;
    const headers = {
      "x-acs-dingtalk-access-token": token,
    };
    const body = {
      downloadCode,
      robotCode,
    };

    // Download as buffer
    const response = await jsonPost(url, body, headers);

    // Check if response contains error
    if (response.errcode && response.errcode !== 0) {
      console.warn(`[dingtalk] Picture download failed: ${response.errmsg}`);
      return { error: response.errmsg || "Download failed" };
    }

    // If response has a file URL, download it with retry
    if (response.downloadUrl) {
      const imageBuffer = await withRetry(
        () => httpGetBuffer(response.downloadUrl),
        3,  // maxRetries
        1000,  // initial delay 1s
        2,  // backoff multiplier
      );

      // Convert to base64
      const base64 = imageBuffer.toString('base64');

      // Also save to temp file for reference
      if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
      }

      const timestamp = Date.now();
      const filename = `picture_${timestamp}.jpg`;
      const filePath = path.join(TEMP_DIR, filename);

      fs.writeFileSync(filePath, imageBuffer);

      console.log(`[dingtalk] Picture downloaded successfully: ${filePath} (${imageBuffer.length} bytes)`);

      return { base64, filePath };
    }

    return { error: "No download URL in response" };
  } catch (err) {
    console.warn(`[dingtalk] Error downloading picture:`, err);
    return { error: String(err) };
  }
}

/** Extension mapping for media types */
const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/amr': '.amr',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
  'application/octet-stream': '.bin',
};

/** Download media file (picture/audio/video/file) from DingTalk */
export async function downloadMediaFile(
  clientId: string,
  clientSecret: string,
  robotCode: string,
  downloadCode: string,
  mediaType?: string,
): Promise<{ filePath?: string; mimeType?: string; error?: string }> {
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);

    const url = `${DINGTALK_API_BASE}/robot/messageFiles/download`;
    const headers = { "x-acs-dingtalk-access-token": token };
    const body = { downloadCode, robotCode };

    const response = await jsonPost(url, body, headers);

    if (response.errcode && response.errcode !== 0) {
      console.warn(`[dingtalk] Media download failed: ${response.errmsg}`);
      return { error: response.errmsg || "Download failed" };
    }

    if (response.downloadUrl) {
      const mediaBuffer = await withRetry(
        () => httpGetBuffer(response.downloadUrl),
        3,  // maxRetries
        1000,  // initial delay 1s
        2,  // backoff multiplier
      );

      if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
      }

      // Determine file extension from content type or media type hint
      const contentType = response.contentType || '';
      const ext = MEDIA_EXTENSIONS[contentType]
        || (mediaType === 'audio' ? '.amr' : undefined)
        || (mediaType === 'video' ? '.mp4' : undefined)
        || (mediaType === 'image' ? '.jpg' : undefined)
        || '.bin';

      const timestamp = Date.now();
      const prefix = mediaType || 'media';
      const filename = `${prefix}_${timestamp}${ext}`;
      const filePath = path.join(TEMP_DIR, filename);

      fs.writeFileSync(filePath, mediaBuffer);

      console.log(`[dingtalk] Media downloaded: ${filePath} (${mediaBuffer.length} bytes, type=${contentType || mediaType || 'unknown'})`);

      return { filePath, mimeType: contentType || undefined };
    }

    return { error: "No download URL in response" };
  } catch (err) {
    console.warn(`[dingtalk] Error downloading media:`, err);
    return { error: String(err) };
  }
}

/** Clean up old media files (older than 1 hour) */
export function cleanupOldMedia(): void {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;

    const files = fs.readdirSync(TEMP_DIR);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);

      if (stats.mtimeMs < oneHourAgo) {
        fs.unlinkSync(filePath);
        console.log(`[dingtalk] Cleaned up old media: ${filePath}`);
      }
    }
  } catch (err) {
    console.warn(`[dingtalk] Error cleaning up media:`, err);
  }
}

/** @deprecated Use cleanupOldMedia() instead */
export const cleanupOldPictures = cleanupOldMedia;

/**
 * Upload a file to DingTalk and get media_id
 * Uses the legacy oapi media upload endpoint (the new API doesn't exist)
 */
export async function uploadMediaFile(params: {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  fileBuffer: Buffer;
  fileName: string;
  fileType?: 'image' | 'voice' | 'video' | 'file';
}): Promise<{ mediaId?: string; error?: string }> {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);

    // Build multipart form data manually
    const boundary = `----DingTalkBoundary${Date.now()}`;
    const fileType = params.fileType || 'file';

    // Construct multipart body - oapi uses "media" as the file field name
    const parts: Buffer[] = [];

    // Add file field
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${params.fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    ));
    parts.push(params.fileBuffer);
    parts.push(Buffer.from('\r\n'));

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    // Use legacy oapi endpoint - the new v1.0 API doesn't have this endpoint
    const url = `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${fileType}`;

    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const req = https.request(urlObj, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 60000, // 60 second timeout for upload
        family: 4,
      }, (res) => {
        let buf = '';
        res.on('data', (chunk: any) => { buf += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(buf);
            // oapi returns media_id (with underscore), not mediaId
            if (json.media_id) {
              console.log(`[dingtalk] File uploaded successfully: media_id=${json.media_id}`);
              resolve({ mediaId: json.media_id });
            } else if (json.mediaId) {
              console.log(`[dingtalk] File uploaded successfully: mediaId=${json.mediaId}`);
              resolve({ mediaId: json.mediaId });
            } else {
              console.warn(`[dingtalk] File upload failed:`, json);
              resolve({ error: json.errmsg || json.message || 'Upload failed' });
            }
          } catch {
            resolve({ error: `Invalid response: ${buf}` });
          }
        });
      });

      req.on('error', (err) => {
        console.warn(`[dingtalk] File upload error:`, err);
        resolve({ error: String(err) });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ error: 'Upload timeout' });
      });

      req.write(body);
      req.end();
    });
  } catch (err) {
    console.warn(`[dingtalk] Error uploading file:`, err);
    return { error: String(err) };
  }
}

/**
 * Send a file message via REST API
 * Requires mediaId from uploadMediaFile
 */
export async function sendFileMessage(params: {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  userId?: string;
  conversationId?: string;
  mediaId: string;
  fileName: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { 'x-acs-dingtalk-access-token': token };

    const msgParam = JSON.stringify({
      mediaId: params.mediaId,
      fileName: params.fileName,
      fileType: getFileExtension(params.fileName),
    });

    if (params.userId) {
      // Send to DM
      const res = await jsonPost(
        `${DINGTALK_API_BASE}/robot/oToMessages/batchSend`,
        {
          robotCode: params.robotCode,
          userIds: [params.userId],
          msgKey: 'sampleFile',
          msgParam,
        },
        headers,
      );

      if (res?.code || res?.errcode) {
        console.warn(`[dingtalk] File send (DM) failed:`, res);
        return { ok: false, error: res.message || res.errmsg };
      }

      console.log(`[dingtalk] File sent to DM: ${params.fileName}`);
      return { ok: true };
    }

    if (params.conversationId) {
      // Send to group
      const res = await jsonPost(
        `${DINGTALK_API_BASE}/robot/groupMessages/send`,
        {
          robotCode: params.robotCode,
          openConversationId: params.conversationId,
          msgKey: 'sampleFile',
          msgParam,
        },
        headers,
      );

      if (res?.code || res?.errcode) {
        console.warn(`[dingtalk] File send (group) failed:`, res);
        return { ok: false, error: res.message || res.errmsg };
      }

      console.log(`[dingtalk] File sent to group: ${params.fileName}`);
      return { ok: true };
    }

    return { ok: false, error: 'Either userId or conversationId required' };
  } catch (err) {
    console.warn(`[dingtalk] Error sending file:`, err);
    return { ok: false, error: String(err) };
  }
}

/** Get file extension from filename */
function getFileExtension(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ext ? ext.slice(1) : 'bin';
}

/**
 * Convert text to a markdown file buffer with UTF-8 BOM
 * BOM is needed for proper Chinese display in DingTalk/Windows
 */
export function textToMarkdownFile(text: string, title?: string): { buffer: Buffer; fileName: string } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = title ? `${title}.md` : `reply_${timestamp}.md`;

  // Add UTF-8 BOM for proper Chinese display
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const content = Buffer.from(text, 'utf-8');
  const buffer = Buffer.concat([bom, content]);

  return { buffer, fileName };
}

// ============================================================================
// Message Recall (撤回) APIs
// ============================================================================

/**
 * Send a DM message and return the processQueryKey for later recall
 * This is an enhanced version that returns the message ID
 */
export async function sendDMMessageWithKey(params: {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  userId: string;
  text: string;
  format?: 'text' | 'markdown';
}): Promise<{ ok: boolean; processQueryKey?: string; error?: string }> {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };

    const useMarkdown = params.format !== 'text';
    const msgKey = useMarkdown ? 'sampleMarkdown' : 'sampleText';
    const msgParam = useMarkdown
      ? JSON.stringify({ title: 'AI', text: params.text })
      : JSON.stringify({ content: params.text });

    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/oToMessages/batchSend`,
      {
        robotCode: params.robotCode,
        userIds: [params.userId],
        msgKey,
        msgParam,
      },
      headers,
    );

    if (res?.code || (res?.errcode && res.errcode !== 0)) {
      console.warn(`[dingtalk] DM send error:`, res);
      return { ok: false, error: res.message || res.errmsg };
    }

    return { 
      ok: true, 
      processQueryKey: res.processQueryKey 
    };
  } catch (err) {
    console.warn(`[dingtalk] Error sending DM:`, err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Send a group message and return the processQueryKey for later recall
 */
export async function sendGroupMessageWithKey(params: {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  conversationId: string;
  text: string;
  format?: 'text' | 'markdown';
}): Promise<{ ok: boolean; processQueryKey?: string; error?: string }> {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };

    const useMarkdown = params.format !== 'text';
    const msgKey = useMarkdown ? 'sampleMarkdown' : 'sampleText';
    const msgParam = useMarkdown
      ? JSON.stringify({ title: 'AI', text: params.text })
      : JSON.stringify({ content: params.text });

    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/groupMessages/send`,
      {
        robotCode: params.robotCode,
        openConversationId: params.conversationId,
        msgKey,
        msgParam,
      },
      headers,
    );

    if (res?.code || (res?.errcode && res.errcode !== 0)) {
      console.warn(`[dingtalk] Group send error:`, res);
      return { ok: false, error: res.message || res.errmsg };
    }

    return { 
      ok: true, 
      processQueryKey: res.processQueryKey 
    };
  } catch (err) {
    console.warn(`[dingtalk] Error sending group message:`, err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Recall (撤回) DM messages
 * Note: This is a "silent recall" - the message just disappears without notification
 */
export async function recallDMMessages(params: {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  userId: string;
  processQueryKeys: string[];
}): Promise<{ ok: boolean; successKeys?: string[]; failedKeys?: Record<string, string>; error?: string }> {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };

    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/otoMessages/batchRecall`,
      {
        robotCode: params.robotCode,
        chatBotUserId: params.userId,
        processQueryKeys: params.processQueryKeys,
      },
      headers,
    );

    if (res?.code || (res?.errcode && res.errcode !== 0)) {
      console.warn(`[dingtalk] DM recall error:`, res);
      return { ok: false, error: res.message || res.errmsg };
    }

    return { 
      ok: true, 
      successKeys: res.successResult,
      failedKeys: res.failedResult,
    };
  } catch (err) {
    console.warn(`[dingtalk] Error recalling DM:`, err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Recall (撤回) group messages
 */
export async function recallGroupMessages(params: {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  conversationId: string;
  processQueryKeys: string[];
}): Promise<{ ok: boolean; successKeys?: string[]; failedKeys?: Record<string, string>; error?: string }> {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };

    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/groupMessages/recall`,
      {
        robotCode: params.robotCode,
        openConversationId: params.conversationId,
        processQueryKeys: params.processQueryKeys,
      },
      headers,
    );

    if (res?.code || (res?.errcode && res.errcode !== 0)) {
      console.warn(`[dingtalk] Group recall error:`, res);
      return { ok: false, error: res.message || res.errmsg };
    }

    return { 
      ok: true, 
      successKeys: res.successResult,
      failedKeys: res.failedResult,
    };
  } catch (err) {
    console.warn(`[dingtalk] Error recalling group message:`, err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Typing indicator helper - sends a "thinking" message that will be recalled
 * Returns a cleanup function to recall the message
 */
export async function sendTypingIndicator(params: {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  userId?: string;
  conversationId?: string;
  message?: string;
}): Promise<{ cleanup: () => Promise<void>; error?: string }> {
  const typingMessage = params.message || "⏳ 思考中...";
  
  try {
    if (params.userId) {
      const result = await sendDMMessageWithKey({
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        robotCode: params.robotCode,
        userId: params.userId,
        text: typingMessage,
        format: 'text',
      });

      if (!result.ok || !result.processQueryKey) {
        return { 
          cleanup: async () => {}, 
          error: result.error || "Failed to send typing indicator" 
        };
      }

      const processQueryKey = result.processQueryKey;
      return {
        cleanup: async () => {
          await recallDMMessages({
            clientId: params.clientId,
            clientSecret: params.clientSecret,
            robotCode: params.robotCode,
            userId: params.userId!,
            processQueryKeys: [processQueryKey],
          });
        }
      };
    }

    if (params.conversationId) {
      const result = await sendGroupMessageWithKey({
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        robotCode: params.robotCode,
        conversationId: params.conversationId,
        text: typingMessage,
        format: 'text',
      });

      if (!result.ok || !result.processQueryKey) {
        return { 
          cleanup: async () => {}, 
          error: result.error || "Failed to send typing indicator" 
        };
      }

      const processQueryKey = result.processQueryKey;
      return {
        cleanup: async () => {
          await recallGroupMessages({
            clientId: params.clientId,
            clientSecret: params.clientSecret,
            robotCode: params.robotCode,
            conversationId: params.conversationId!,
            processQueryKeys: [processQueryKey],
          });
        }
      };
    }

    return { cleanup: async () => {}, error: "Either userId or conversationId required" };
  } catch (err) {
    console.warn(`[dingtalk] Error sending typing indicator:`, err);
    return { cleanup: async () => {}, error: String(err) };
  }
}
