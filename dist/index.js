var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/api.ts
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
function jsonPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(urlObj, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers
      },
      timeout: 1e4,
      // 10 second timeout
      family: 4
      // Force IPv4 to avoid IPv6 connection issues
    }, (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch {
          resolve({ raw: buf });
        }
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
function httpGetBuffer(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(urlObj, {
      method: "GET",
      headers: headers || {},
      timeout: 3e4,
      // 30 second timeout for file downloads
      family: 4
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
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
async function withRetry(fn, maxRetries = 3, delayMs = 1e3, backoffMultiplier = 2) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = delayMs * Math.pow(backoffMultiplier, attempt - 1);
        console.log(`[dingtalk] Retry ${attempt}/${maxRetries} after ${delay}ms: ${lastError.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}
async function getDingTalkAccessToken(clientId, clientSecret) {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now() + 6e4) {
    return cached.token;
  }
  const res = await jsonPost(`${DINGTALK_API_BASE}/oauth2/accessToken`, {
    appKey: clientId,
    appSecret: clientSecret
  });
  if (!res.accessToken) {
    throw new Error(`DingTalk token error: ${JSON.stringify(res)}`);
  }
  tokenCache.set(clientId, {
    token: res.accessToken,
    expiresAt: Date.now() + (res.expireIn ?? 7200) * 1e3
  });
  return res.accessToken;
}
async function sendViaSessionWebhook(sessionWebhook, text, atUserIds) {
  const body = {
    msgtype: "text",
    text: { content: text }
  };
  if (atUserIds?.length) {
    body.at = { atUserIds, isAtAll: false };
  }
  const res = await jsonPost(sessionWebhook, body);
  const ok = res?.errcode === 0 || !res?.errcode;
  if (!ok) {
    console.warn(`[dingtalk] SessionWebhook text error: errcode=${res?.errcode}, errmsg=${res?.errmsg}`);
  }
  return { ok, errcode: res?.errcode, errmsg: res?.errmsg, processQueryKey: res?.processQueryKey || res?.requestId };
}
async function sendMarkdownViaSessionWebhook(sessionWebhook, title, text, atUserIds) {
  const body = {
    msgtype: "markdown",
    markdown: { title, text }
  };
  if (atUserIds?.length) {
    body.at = { atUserIds, isAtAll: false };
  }
  const res = await jsonPost(sessionWebhook, body);
  const ok = res?.errcode === 0 || !res?.errcode;
  if (!ok) {
    console.warn(`[dingtalk] SessionWebhook markdown error: errcode=${res?.errcode}, errmsg=${res?.errmsg}`);
  }
  return { ok, errcode: res?.errcode, errmsg: res?.errmsg, processQueryKey: res?.processQueryKey || res?.requestId };
}
async function sendDingTalkRestMessage(params) {
  const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
  const headers = { "x-acs-dingtalk-access-token": token };
  const useMarkdown = params.format !== "text";
  const msgKey = useMarkdown ? "sampleMarkdown" : "sampleText";
  const msgParam = useMarkdown ? JSON.stringify({ title: "AI", text: params.text }) : JSON.stringify({ content: params.text });
  if (params.userId) {
    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/oToMessages/batchSend`,
      {
        robotCode: params.robotCode,
        userIds: [params.userId],
        msgKey,
        msgParam
      },
      headers
    );
    if (res?.errcode && res.errcode !== 0) {
      throw new Error(`DingTalk DM send error: ${JSON.stringify(res)}`);
    }
    return { ok: !!res?.processQueryKey || !res?.code, processQueryKey: res?.processQueryKey || res?.result?.processQueryKey };
  }
  if (params.conversationId) {
    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/groupMessages/send`,
      {
        robotCode: params.robotCode,
        openConversationId: params.conversationId,
        msgKey,
        msgParam
      },
      headers
    );
    if (res?.errcode && res.errcode !== 0) {
      throw new Error(`DingTalk group send error: ${JSON.stringify(res)}`);
    }
    return { ok: !!res?.processQueryKey || !res?.code, processQueryKey: res?.processQueryKey || res?.result?.processQueryKey };
  }
  throw new Error("Either userId or conversationId required");
}
function loadUserCache() {
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
  userCache = /* @__PURE__ */ new Map();
  return userCache;
}
function saveUserCache(cache) {
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
async function getUserInfo(clientId, clientSecret, userid) {
  const cache = loadUserCache();
  const cached = cache.get(userid);
  if (cached) return cached;
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const res = await jsonPost(
      `${DINGTALK_OAPI_BASE}/topapi/v2/user/get?access_token=${token}`,
      {
        userid,
        language: "zh_CN"
      }
    );
    if (res.errcode !== 0) {
      console.warn(`[dingtalk] Failed to get user info for ${userid}: ${res.errmsg}`);
      return null;
    }
    const userInfo = {
      name: res.result?.name || userid,
      avatar: res.result?.avatar
    };
    cache.set(userid, userInfo);
    saveUserCache(cache);
    return userInfo;
  } catch (err) {
    console.warn(`[dingtalk] Error getting user info for ${userid}:`, err);
    return null;
  }
}
async function batchGetUserInfo(clientId, clientSecret, userids, timeoutMs = 500) {
  const result = /* @__PURE__ */ new Map();
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
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))
    ]);
  } catch (err) {
    console.warn(`[dingtalk] Batch user info fetch timeout/error:`, err);
  }
  return result;
}
async function downloadPicture(clientId, clientSecret, robotCode, downloadCode) {
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const url = `${DINGTALK_API_BASE}/robot/messageFiles/download`;
    const headers = {
      "x-acs-dingtalk-access-token": token
    };
    const body = {
      downloadCode,
      robotCode
    };
    const response = await jsonPost(url, body, headers);
    if (response.errcode && response.errcode !== 0) {
      console.warn(`[dingtalk] Picture download failed: ${response.errmsg}`);
      return { error: response.errmsg || "Download failed" };
    }
    if (response.downloadUrl) {
      const imageBuffer = await withRetry(
        () => httpGetBuffer(response.downloadUrl),
        3,
        // maxRetries
        1e3,
        // initial delay 1s
        2
        // backoff multiplier
      );
      const base64 = imageBuffer.toString("base64");
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
async function downloadMediaFile(clientId, clientSecret, robotCode, downloadCode, mediaType, originalFileName) {
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
        3,
        // maxRetries
        1e3,
        // initial delay 1s
        2
        // backoff multiplier
      );
      if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
      }
      const contentType = response.contentType || "";
      let filename;
      if (originalFileName && path.extname(originalFileName)) {
        const ext = path.extname(originalFileName);
        const base = path.basename(originalFileName, ext).replace(/[^\w\u4e00-\u9fa5.-]/g, "_").slice(0, 60);
        filename = `${base}_${Date.now()}${ext}`;
      } else {
        const ext = MEDIA_EXTENSIONS[contentType] || (mediaType === "audio" ? ".amr" : void 0) || (mediaType === "video" ? ".mp4" : void 0) || (mediaType === "image" ? ".jpg" : void 0) || (originalFileName ? path.extname(originalFileName) : void 0) || ".bin";
        const prefix = mediaType || "media";
        filename = `${prefix}_${Date.now()}${ext}`;
      }
      const filePath = path.join(TEMP_DIR, filename);
      fs.writeFileSync(filePath, mediaBuffer);
      console.log(`[dingtalk] Media downloaded: ${filePath} (${mediaBuffer.length} bytes, type=${contentType || mediaType || "unknown"})`);
      return { filePath, mimeType: contentType || void 0 };
    }
    return { error: "No download URL in response" };
  } catch (err) {
    console.warn(`[dingtalk] Error downloading media:`, err);
    return { error: String(err) };
  }
}
function cleanupOldMedia() {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    const files = fs.readdirSync(TEMP_DIR);
    const oneHourAgo = Date.now() - 60 * 60 * 1e3;
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
async function uploadMediaFile(params) {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const boundary = `----DingTalkBoundary${Date.now()}`;
    const fileType = params.fileType || "file";
    const parts = [];
    parts.push(Buffer.from(
      `--${boundary}\r
Content-Disposition: form-data; name="media"; filename="${params.fileName}"\r
Content-Type: application/octet-stream\r
\r
`
    ));
    parts.push(params.fileBuffer);
    parts.push(Buffer.from("\r\n"));
    parts.push(Buffer.from(`--${boundary}--\r
`));
    const body = Buffer.concat(parts);
    const url = `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${fileType}`;
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const req = https.request(urlObj, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length
        },
        timeout: 6e4,
        // 60 second timeout for upload
        family: 4
      }, (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(buf);
            if (json.media_id) {
              console.log(`[dingtalk] File uploaded successfully: media_id=${json.media_id}`);
              resolve({ mediaId: json.media_id });
            } else if (json.mediaId) {
              console.log(`[dingtalk] File uploaded successfully: mediaId=${json.mediaId}`);
              resolve({ mediaId: json.mediaId });
            } else {
              console.warn(`[dingtalk] File upload failed:`, json);
              resolve({ error: json.errmsg || json.message || "Upload failed" });
            }
          } catch {
            resolve({ error: `Invalid response: ${buf}` });
          }
        });
      });
      req.on("error", (err) => {
        console.warn(`[dingtalk] File upload error:`, err);
        resolve({ error: String(err) });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ error: "Upload timeout" });
      });
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.warn(`[dingtalk] Error uploading file:`, err);
    return { error: String(err) };
  }
}
async function sendFileMessage(params) {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };
    const msgParam = JSON.stringify({
      mediaId: params.mediaId,
      fileName: params.fileName,
      fileType: getFileExtension(params.fileName)
    });
    if (params.userId) {
      const res = await jsonPost(
        `${DINGTALK_API_BASE}/robot/oToMessages/batchSend`,
        {
          robotCode: params.robotCode,
          userIds: [params.userId],
          msgKey: "sampleFile",
          msgParam
        },
        headers
      );
      if (res?.code || res?.errcode) {
        console.warn(`[dingtalk] File send (DM) failed:`, res);
        return { ok: false, error: res.message || res.errmsg };
      }
      console.log(`[dingtalk] File sent to DM: ${params.fileName}`);
      return { ok: true };
    }
    if (params.conversationId) {
      const res = await jsonPost(
        `${DINGTALK_API_BASE}/robot/groupMessages/send`,
        {
          robotCode: params.robotCode,
          openConversationId: params.conversationId,
          msgKey: "sampleFile",
          msgParam
        },
        headers
      );
      if (res?.code || res?.errcode) {
        console.warn(`[dingtalk] File send (group) failed:`, res);
        return { ok: false, error: res.message || res.errmsg };
      }
      console.log(`[dingtalk] File sent to group: ${params.fileName}`);
      return { ok: true };
    }
    return { ok: false, error: "Either userId or conversationId required" };
  } catch (err) {
    console.warn(`[dingtalk] Error sending file:`, err);
    return { ok: false, error: String(err) };
  }
}
function getFileExtension(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext ? ext.slice(1) : "bin";
}
function textToMarkdownFile(text, title) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = title ? `${title}.md` : `reply_${timestamp}.md`;
  const bom = Buffer.from([239, 187, 191]);
  const content = Buffer.from(text, "utf-8");
  const buffer = Buffer.concat([bom, content]);
  return { buffer, fileName };
}
async function sendDMMessageWithKey(params) {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };
    const useMarkdown = params.format !== "text";
    const msgKey = useMarkdown ? "sampleMarkdown" : "sampleText";
    const msgParam = useMarkdown ? JSON.stringify({ title: "AI", text: params.text }) : JSON.stringify({ content: params.text });
    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/oToMessages/batchSend`,
      {
        robotCode: params.robotCode,
        userIds: [params.userId],
        msgKey,
        msgParam
      },
      headers
    );
    if (res?.code || res?.errcode && res.errcode !== 0) {
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
async function sendGroupMessageWithKey(params) {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };
    const useMarkdown = params.format !== "text";
    const msgKey = useMarkdown ? "sampleMarkdown" : "sampleText";
    const msgParam = useMarkdown ? JSON.stringify({ title: "AI", text: params.text }) : JSON.stringify({ content: params.text });
    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/groupMessages/send`,
      {
        robotCode: params.robotCode,
        openConversationId: params.conversationId,
        msgKey,
        msgParam
      },
      headers
    );
    if (res?.code || res?.errcode && res.errcode !== 0) {
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
async function recallDMMessages(params) {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };
    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/otoMessages/batchRecall`,
      {
        robotCode: params.robotCode,
        chatBotUserId: params.userId,
        processQueryKeys: params.processQueryKeys
      },
      headers
    );
    if (res?.code || res?.errcode && res.errcode !== 0) {
      console.warn(`[dingtalk] DM recall error:`, res);
      return { ok: false, error: res.message || res.errmsg };
    }
    return {
      ok: true,
      successKeys: res.successResult,
      failedKeys: res.failedResult
    };
  } catch (err) {
    console.warn(`[dingtalk] Error recalling DM:`, err);
    return { ok: false, error: String(err) };
  }
}
async function recallGroupMessages(params) {
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };
    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/groupMessages/recall`,
      {
        robotCode: params.robotCode,
        openConversationId: params.conversationId,
        processQueryKeys: params.processQueryKeys
      },
      headers
    );
    if (res?.code || res?.errcode && res.errcode !== 0) {
      console.warn(`[dingtalk] Group recall error:`, res);
      return { ok: false, error: res.message || res.errmsg };
    }
    return {
      ok: true,
      successKeys: res.successResult,
      failedKeys: res.failedResult
    };
  } catch (err) {
    console.warn(`[dingtalk] Error recalling group message:`, err);
    return { ok: false, error: String(err) };
  }
}
async function addEmotionReply(params) {
  const emotionName = params.emotionName || "\u{1F914}\u601D\u8003\u4E2D";
  try {
    const token = await getDingTalkAccessToken(params.clientId, params.clientSecret);
    const res = await jsonPost(
      `${DINGTALK_API_BASE}/robot/emotion/reply`,
      {
        robotCode: params.robotCode,
        openMsgId: params.msgId,
        openConversationId: params.conversationId,
        emotionType: 2,
        emotionName,
        textEmotion: {
          emotionId: "2659900",
          emotionName,
          text: emotionName,
          backgroundId: "im_bg_1"
        }
      },
      { "x-acs-dingtalk-access-token": token }
    );
    if (res?.errcode && res.errcode !== 0) {
      return { cleanup: async () => {
      }, error: `emotion reply failed: ${res.errmsg || res.errcode}` };
    }
    return {
      cleanup: async () => {
        try {
          const t = await getDingTalkAccessToken(params.clientId, params.clientSecret);
          await jsonPost(
            `${DINGTALK_API_BASE}/robot/emotion/recall`,
            {
              robotCode: params.robotCode,
              openMsgId: params.msgId,
              openConversationId: params.conversationId,
              emotionType: 2,
              emotionName,
              textEmotion: {
                emotionId: "2659900",
                emotionName,
                text: emotionName,
                backgroundId: "im_bg_1"
              }
            },
            { "x-acs-dingtalk-access-token": t }
          );
        } catch (_) {
        }
      }
    };
  } catch (err) {
    return { cleanup: async () => {
    }, error: String(err) };
  }
}
async function sendTypingIndicator(params) {
  const typingMessage = params.message || "\u23F3 \u601D\u8003\u4E2D...";
  try {
    if (params.userId) {
      const result = await sendDMMessageWithKey({
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        robotCode: params.robotCode,
        userId: params.userId,
        text: typingMessage,
        format: "text"
      });
      if (!result.ok || !result.processQueryKey) {
        return {
          cleanup: async () => {
          },
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
            userId: params.userId,
            processQueryKeys: [processQueryKey]
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
        format: "text"
      });
      if (!result.ok || !result.processQueryKey) {
        return {
          cleanup: async () => {
          },
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
            conversationId: params.conversationId,
            processQueryKeys: [processQueryKey]
          });
        }
      };
    }
    return { cleanup: async () => {
    }, error: "Either userId or conversationId required" };
  } catch (err) {
    console.warn(`[dingtalk] Error sending typing indicator:`, err);
    return { cleanup: async () => {
    }, error: String(err) };
  }
}
var DINGTALK_API_BASE, DINGTALK_OAPI_BASE, TEMP_DIR, tokenCache, USER_CACHE_FILE, userCache, MEDIA_EXTENSIONS;
var init_api = __esm({
  "src/api.ts"() {
    DINGTALK_API_BASE = "https://api.dingtalk.com/v1.0";
    DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";
    TEMP_DIR = path.join(os.tmpdir(), "dingtalk-media");
    tokenCache = /* @__PURE__ */ new Map();
    USER_CACHE_FILE = path.join(os.homedir(), ".clawdbot", "extensions", "dingtalk", ".cache", "users.json");
    userCache = null;
    MEDIA_EXTENSIONS = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "audio/amr": ".amr",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "video/mp4": ".mp4",
      "application/pdf": ".pdf",
      "application/octet-stream": ".bin"
    };
  }
});

// src/probe.ts
async function probeDingTalk(clientId, clientSecret) {
  const startTime = Date.now();
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    if (!token) {
      return {
        ok: false,
        error: "Failed to get access token",
        latency: Date.now() - startTime
      };
    }
    return {
      ok: true,
      latency: Date.now() - startTime
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latency: Date.now() - startTime
    };
  }
}
var init_probe = __esm({
  "src/probe.ts"() {
    init_api();
  }
});

// src/onboarding.ts
var onboarding_exports = {};
__export(onboarding_exports, {
  onboardDingTalk: () => onboardDingTalk
});
async function onboardDingTalk(ctx) {
  const { runtime } = ctx;
  const ui = runtime.ui;
  ui.info("\u6B22\u8FCE\u4F7F\u7528\u9489\u9489\u63D2\u4EF6\u914D\u7F6E\u5411\u5BFC\uFF01\n");
  ui.info("Step 1/4: \u83B7\u53D6\u9489\u9489\u5E94\u7528\u51ED\u8BC1");
  ui.info("\u8BF7\u5728\u9489\u9489\u5F00\u53D1\u8005\u5E73\u53F0\u521B\u5EFA\u4F01\u4E1A\u5185\u90E8\u5E94\u7528\uFF1A");
  ui.info("https://open-dev.dingtalk.com/\n");
  const clientId = await ui.prompt({
    type: "text",
    message: "\u8BF7\u8F93\u5165 Client ID (AppKey):",
    validate: (val) => val.trim().length > 0 || "\u4E0D\u80FD\u4E3A\u7A7A"
  });
  const clientSecret = await ui.prompt({
    type: "password",
    message: "\u8BF7\u8F93\u5165 Client Secret (AppSecret):",
    validate: (val) => val.trim().length > 0 || "\u4E0D\u80FD\u4E3A\u7A7A"
  });
  ui.info("\nStep 2/4: \u6D4B\u8BD5\u8FDE\u63A5...");
  try {
    const result = await probeDingTalk(clientId, clientSecret);
    if (result.ok) {
      ui.success(`\u2713 \u8FDE\u63A5\u6210\u529F\uFF01\u5EF6\u8FDF: ${result.latency}ms`);
    } else {
      throw new Error(result.error || "\u8FDE\u63A5\u5931\u8D25");
    }
  } catch (error) {
    ui.error(`\u2717 \u8FDE\u63A5\u5931\u8D25: ${error}`);
    const retry = await ui.confirm("\u662F\u5426\u91CD\u65B0\u8F93\u5165\u51ED\u8BC1?");
    if (retry) {
      return onboardDingTalk(ctx);
    }
    throw new Error("\u914D\u7F6E\u53D6\u6D88");
  }
  ui.info("\nStep 3/4: \u914D\u7F6E\u79C1\u804A\u7B56\u7565");
  const dmPolicy = await ui.select({
    message: "\u9009\u62E9\u79C1\u804A\u7B56\u7565:",
    choices: [
      {
        value: "pairing",
        label: "Pairing (\u63A8\u8350)",
        description: "\u9996\u6B21\u8054\u7CFB\u65F6\u663E\u793A staffId\uFF0C\u9700\u7BA1\u7406\u5458\u6DFB\u52A0\u767D\u540D\u5355"
      },
      {
        value: "allowlist",
        label: "Allowlist",
        description: "\u53EA\u5141\u8BB8\u6307\u5B9A\u7528\u6237\u79C1\u804A"
      },
      {
        value: "open",
        label: "Open",
        description: "\u4EFB\u4F55\u4EBA\u90FD\u53EF\u4EE5\u79C1\u804A\uFF08\u4E0D\u63A8\u8350\uFF09"
      },
      {
        value: "disabled",
        label: "Disabled",
        description: "\u7981\u7528\u79C1\u804A"
      }
    ],
    default: "pairing"
  });
  let dmAllowlist = [];
  if (dmPolicy === "allowlist") {
    const input = await ui.prompt({
      type: "text",
      message: "\u8F93\u5165\u5141\u8BB8\u7684 staffId\uFF08\u9017\u53F7\u5206\u9694\uFF09:",
      default: ""
    });
    dmAllowlist = input.split(",").map((s) => s.trim()).filter(Boolean);
  }
  ui.info("\nStep 4/4: \u914D\u7F6E\u7FA4\u804A\u7B56\u7565");
  const groupPolicy = await ui.select({
    message: "\u9009\u62E9\u7FA4\u804A\u7B56\u7565:",
    choices: [
      {
        value: "allowlist",
        label: "Allowlist (\u63A8\u8350)",
        description: "\u53EA\u5141\u8BB8\u6307\u5B9A\u7FA4\u804A"
      },
      {
        value: "open",
        label: "Open",
        description: "\u5141\u8BB8\u6240\u6709\u7FA4\u804A"
      },
      {
        value: "disabled",
        label: "Disabled",
        description: "\u7981\u7528\u7FA4\u804A"
      }
    ],
    default: "allowlist"
  });
  let groupAllowlist = [];
  if (groupPolicy === "allowlist") {
    ui.info("\n\u83B7\u53D6\u7FA4\u804A conversationId \u7684\u65B9\u6CD5\uFF1A");
    ui.info("  1. \u5C06\u673A\u5668\u4EBA\u6DFB\u52A0\u5230\u7FA4\u804A");
    ui.info("  2. \u5728\u7FA4\u804A\u4E2D @\u673A\u5668\u4EBA \u53D1\u9001\u6D88\u606F");
    ui.info("  3. \u67E5\u770B\u65E5\u5FD7\u627E\u5230 conversationId\n");
    const input = await ui.prompt({
      type: "text",
      message: "conversationId (\u53EF\u7A0D\u540E\u6DFB\u52A0):",
      default: ""
    });
    groupAllowlist = input.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const requireMention = await ui.confirm({
    message: "\u5728\u7FA4\u804A\u4E2D\u662F\u5426\u8981\u6C42 @\u673A\u5668\u4EBA?",
    default: true
  });
  const config = {
    enabled: true,
    clientId,
    clientSecret,
    dm: {
      enabled: dmPolicy !== "disabled",
      policy: dmPolicy,
      allowFrom: dmAllowlist
    },
    groupPolicy,
    groupAllowlist,
    requireMention,
    messageFormat: "text"
  };
  await runtime.config.set("channels.dingtalk", config);
  ui.success("\n\u2713 \u914D\u7F6E\u5B8C\u6210\uFF01");
  ui.info("\u4E0B\u4E00\u6B65: \u8FD0\u884C clawdbot gateway \u542F\u52A8\u7F51\u5173\n");
  return config;
}
var init_onboarding = __esm({
  "src/onboarding.ts"() {
    init_probe();
  }
});

// src/runtime.ts
var runtimeRef = null;
function setDingTalkRuntime(runtime) {
  runtimeRef = runtime;
}
function getDingTalkRuntime() {
  if (!runtimeRef) throw new Error("DingTalk runtime not initialized");
  return runtimeRef;
}

// src/config-schema.ts
import { z } from "zod";
var dmPolicySchema = z.enum(["disabled", "pairing", "allowlist", "open"], {
  description: "DM access control policy"
});
var groupPolicySchema = z.enum(["disabled", "allowlist", "open"], {
  description: "Group chat access control policy"
});
var messageFormatSchema = z.enum(["text", "markdown", "richtext", "auto"], {
  description: "Message format for bot responses (richtext is an alias for markdown, auto detects markdown features)"
});
var longTextModeSchema = z.enum(["chunk", "file"]);
var dingTalkAccountConfigSchema = z.object({
  enabled: z.boolean().default(true).describe("Enable this account"),
  name: z.string().optional().describe("Display name for this account"),
  // Credentials
  clientId: z.string().optional().describe("DingTalk application AppKey"),
  clientSecret: z.string().optional().describe("DingTalk application AppSecret"),
  robotCode: z.string().optional().describe("Robot code (optional, defaults to clientId if not provided)"),
  // DM config
  dm: z.object({
    enabled: z.boolean().default(true).describe("Enable direct messages"),
    policy: dmPolicySchema.default("pairing").describe(
      "Access control policy:\n  - disabled: No DM allowed\n  - pairing: Show staffId on first contact, admin adds to allowlist\n  - allowlist: Only specified users can DM\n  - open: Anyone can DM (not recommended)"
    ),
    allowFrom: z.array(z.string()).default([]).describe("Allowed staff IDs (for pairing/allowlist policy)")
  }).default({}),
  // Group config
  groupPolicy: groupPolicySchema.default("allowlist").describe(
    "Group chat policy:\n  - disabled: No groups\n  - allowlist: Only specified groups\n  - open: All groups"
  ),
  groupAllowlist: z.array(z.string()).default([]).describe('Allowed group conversation IDs (only used when groupPolicy is "allowlist")'),
  requireMention: z.boolean().default(true).describe("Require @ mention in group chats"),
  // Message format
  messageFormat: messageFormatSchema.default("text").describe(
    "Message format:\n  - text: Plain text (recommended, supports tables)\n  - markdown: DingTalk markdown (limited support, no tables)\n  - richtext: Alias for markdown (deprecated, use markdown instead)\n  - auto: Auto-detect markdown features in response"
  ),
  // Thinking feedback
  showThinking: z.boolean().default(false).describe('Send "\u6B63\u5728\u601D\u8003..." feedback before AI responds'),
  // Advanced
  textChunkLimit: z.number().int().positive().default(2e3).optional().describe("Text chunk size limit for long messages"),
  longTextMode: longTextModeSchema.default("chunk").describe(
    "How to handle long text messages:\n  - chunk: Split into multiple messages (default, same as official channels)\n  - file: Convert to .md file and send as attachment"
  ),
  longTextThreshold: z.number().int().positive().default(8e3).optional().describe("Character threshold for longTextMode=file (default 8000)"),
  // Per-group overrides
  groups: z.record(z.string(), z.object({
    systemPrompt: z.string().optional().describe("Per-group extra system prompt injected as GroupSystemPrompt"),
    enabled: z.boolean().optional().describe("Disable this group (false = ignore all messages)"),
    allowFrom: z.array(z.string()).optional().describe('Only respond to messages from these senderStaffIds in this group (supports "*" wildcard). If omitted, all senders are allowed.')
  })).optional().default({}).describe("Per-group overrides keyed by conversationId"),
  // Message aggregation
  messageAggregation: z.boolean().default(true).describe(
    "Aggregate messages from the same sender within a short time window.\nUseful when DingTalk splits link cards into multiple messages."
  ),
  messageAggregationDelayMs: z.number().int().positive().default(2e3).optional().describe("Time window in milliseconds to wait for additional messages (default 2000)")
}).passthrough();
var dingTalkConfigSchema = dingTalkAccountConfigSchema.extend({
  accounts: z.record(z.string(), dingTalkAccountConfigSchema.partial().optional()).optional().describe("Named accounts that override top-level settings"),
  defaultAccount: z.string().optional().describe("Default account ID (if accounts are defined)")
});
function validateDingTalkAccountConfig(config) {
  return dingTalkAccountConfigSchema.parse(config);
}

// src/accounts.ts
var DEFAULT_ACCOUNT_ID = "default";
var ENV_CLIENT_ID = "DINGTALK_CLIENT_ID";
var ENV_CLIENT_SECRET = "DINGTALK_CLIENT_SECRET";
var ENV_ROBOT_CODE = "DINGTALK_ROBOT_CODE";
function listDingTalkAccountIds(cfg) {
  const channel = cfg?.channels?.dingtalk;
  if (!channel) return [];
  if (channel.accounts && typeof channel.accounts === "object") {
    const ids = Object.keys(channel.accounts).filter((id) => {
      const acct = channel.accounts[id];
      return acct && acct.enabled !== false;
    });
    if (ids.length > 0) return ids;
  }
  if (channel.clientId) return [DEFAULT_ACCOUNT_ID];
  return [];
}
function resolveDefaultDingTalkAccountId(cfg) {
  const channel = cfg?.channels?.dingtalk;
  if (!channel) return DEFAULT_ACCOUNT_ID;
  if (channel.defaultAccount) return channel.defaultAccount;
  if (channel.accounts && typeof channel.accounts === "object") {
    const ids = Object.keys(channel.accounts);
    if (ids.length > 0) return ids[0];
  }
  return DEFAULT_ACCOUNT_ID;
}
function resolveDingTalkAccount(params) {
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const rawChannel = params.cfg?.channels?.dingtalk ?? {};
  const { accounts, defaultAccount, ...baseConfig } = rawChannel;
  let accountOverride = {};
  if (accounts && typeof accounts === "object" && accountId !== DEFAULT_ACCOUNT_ID) {
    accountOverride = accounts[accountId] ?? {};
  } else if (accounts && typeof accounts === "object" && accountId === DEFAULT_ACCOUNT_ID) {
    accountOverride = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  }
  const { clientId: _baseClientId, clientSecret: _baseClientSecret, robotCode: _baseRobotCode, ...baseNonCreds } = baseConfig;
  const merged = {
    ...baseNonCreds,
    ...accountOverride,
    // Credentials: use account override first, then base, but robotCode only inherits
    // if clientId also inherits (i.e. they belong to the same bot)
    clientId: accountOverride.clientId || baseConfig.clientId,
    clientSecret: accountOverride.clientSecret || baseConfig.clientSecret,
    robotCode: accountOverride.robotCode || (accountOverride.clientId ? void 0 : baseConfig.robotCode),
    // Deep merge dm
    dm: { ...baseConfig.dm ?? {}, ...accountOverride.dm ?? {} },
    // Deep merge groups
    groups: { ...baseConfig.groups ?? {}, ...accountOverride.groups ?? {} }
  };
  if (accountId === DEFAULT_ACCOUNT_ID) {
    merged.clientId = merged.clientId || process.env[ENV_CLIENT_ID];
    merged.clientSecret = merged.clientSecret || process.env[ENV_CLIENT_SECRET];
    merged.robotCode = merged.robotCode || process.env[ENV_ROBOT_CODE];
  }
  let validatedConfig;
  let credentialSource = "none";
  try {
    validatedConfig = validateDingTalkAccountConfig(merged);
    const rawClientId = accountOverride.clientId || baseConfig.clientId;
    const rawClientSecret = accountOverride.clientSecret || baseConfig.clientSecret;
    if (rawClientId && rawClientSecret) {
      credentialSource = "config";
    } else if (validatedConfig.clientId && validatedConfig.clientSecret) {
      credentialSource = "env";
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `DingTalk configuration validation failed for account "${accountId}":
${errorMsg}

Please check your configuration at channels.dingtalk` + (accountId !== DEFAULT_ACCOUNT_ID ? `.accounts.${accountId}` : "") + ` or set environment variables:
  - ${ENV_CLIENT_ID}
  - ${ENV_CLIENT_SECRET}
  - ${ENV_ROBOT_CODE} (optional)`
    );
  }
  const configured = !!(validatedConfig.clientId && validatedConfig.clientSecret);
  return {
    accountId,
    name: validatedConfig.name || (accountId === DEFAULT_ACCOUNT_ID ? "DingTalk Bot" : accountId),
    enabled: validatedConfig.enabled,
    configured,
    clientId: validatedConfig.clientId,
    clientSecret: validatedConfig.clientSecret,
    robotCode: validatedConfig.robotCode || validatedConfig.clientId,
    credentialSource,
    config: validatedConfig
  };
}

// src/monitor.ts
init_api();

// src/quoted-msg-cache.ts
import * as fs2 from "fs";
import * as path2 from "path";
import * as os2 from "os";
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
var MAX_ENTRIES_PER_BUCKET = 100;
var MAX_BUCKETS = 1e3;
var CACHE_FILE = path2.join(
  os2.homedir(),
  ".openclaw",
  "extensions",
  "dingtalk",
  ".cache",
  "quoted-msg-cache.json"
);
var store = /* @__PURE__ */ new Map();
var bucketOrder = [];
function loadFromDisk() {
  try {
    if (!fs2.existsSync(CACHE_FILE)) return;
    const raw = fs2.readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    const cutoff = Date.now() - DEFAULT_TTL_MS;
    for (const [bucketKey2, entries] of Object.entries(data)) {
      const bucket = /* @__PURE__ */ new Map();
      for (const [msgId, entry] of entries) {
        if (entry.cachedAt > cutoff) {
          bucket.set(msgId, entry);
        }
      }
      if (bucket.size > 0) {
        store.set(bucketKey2, bucket);
        bucketOrder.push(bucketKey2);
      }
    }
  } catch {
  }
}
var _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const dir = path2.dirname(CACHE_FILE);
      if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [bk, bucket] of store) {
        obj[bk] = [...bucket.entries()];
      }
      const tmp = CACHE_FILE + ".tmp";
      fs2.writeFileSync(tmp, JSON.stringify(obj), "utf-8");
      fs2.renameSync(tmp, CACHE_FILE);
    } catch {
    }
  }, 2e3);
}
loadFromDisk();
function bucketKey(accountId, conversationId) {
  return `${accountId}:${conversationId}`;
}
function touchBucket(key) {
  const idx = bucketOrder.indexOf(key);
  if (idx >= 0) bucketOrder.splice(idx, 1);
  bucketOrder.push(key);
}
function getOrCreateBucket(key) {
  let bucket = store.get(key);
  if (!bucket) {
    while (bucketOrder.length >= MAX_BUCKETS) {
      const oldest = bucketOrder.shift();
      if (oldest) store.delete(oldest);
    }
    bucket = /* @__PURE__ */ new Map();
    store.set(key, bucket);
  }
  touchBucket(key);
  return bucket;
}
function evictBucket(bucket) {
  if (bucket.size <= MAX_ENTRIES_PER_BUCKET) return;
  const cutoff = Date.now() - DEFAULT_TTL_MS;
  for (const [k, v] of bucket) {
    if (v.cachedAt < cutoff) bucket.delete(k);
  }
  while (bucket.size > MAX_ENTRIES_PER_BUCKET) {
    let oldestKey;
    let oldestTs = Infinity;
    for (const [k, v] of bucket) {
      if (v.cachedAt < oldestTs) {
        oldestTs = v.cachedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) bucket.delete(oldestKey);
    else break;
  }
}
function cacheInboundDownloadCode(accountId, conversationId, msgId, downloadCode, msgType, createdAt, extra) {
  const bk = bucketKey(accountId, conversationId);
  const bucket = getOrCreateBucket(bk);
  bucket.set(msgId, {
    downloadCode,
    spaceId: extra?.spaceId,
    fileId: extra?.fileId,
    msgType,
    createdAt,
    cachedAt: Date.now()
  });
  evictBucket(bucket);
  scheduleSave();
}
function getCachedDownloadCode(accountId, conversationId, msgId) {
  const bk = bucketKey(accountId, conversationId);
  const bucket = store.get(bk);
  if (!bucket) return null;
  const entry = bucket.get(msgId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > DEFAULT_TTL_MS) {
    bucket.delete(msgId);
    scheduleSave();
    return null;
  }
  touchBucket(bk);
  return entry;
}

// src/quoted-file-service.ts
init_api();
import https2 from "node:https";
import http2 from "node:http";
import fs3 from "node:fs";
import path3 from "node:path";
import os3 from "node:os";
var DINGTALK_API = "https://api.dingtalk.com/v1.0";
var DINGTALK_OAPI = "https://oapi.dingtalk.com";
var PAGE_SIZE = 50;
var MAX_PAGES = 3;
var TIME_TOLERANCE_MS = 1e4;
var TEMP_DIR2 = path3.join(os3.tmpdir(), "dingtalk-media");
var unionIdCache = /* @__PURE__ */ new Map();
var UNION_CACHE_MAX = 5e3;
var spaceIdCache = /* @__PURE__ */ new Map();
var SPACE_CACHE_MAX = 500;
function lruSet(map, key, value, max) {
  if (map.size >= max) {
    const first = map.keys().next().value;
    if (first !== void 0) map.delete(first);
  }
  map.set(key, value);
}
function jsonPost2(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https2 : http2;
    const req = mod.request(urlObj, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)), ...headers },
      timeout: 15e3,
      family: 4
    }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch {
          resolve({ raw: buf });
        }
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
function jsonGet(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https2 : http2;
    const req = mod.request(urlObj, {
      method: "GET",
      headers: { ...headers },
      timeout: 15e3,
      family: 4
    }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch {
          resolve({ raw: buf });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}
function downloadBuffer(url, headers, forceIPv4 = false) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https2 : http2;
    const opts = {
      method: "GET",
      headers: headers || {},
      timeout: 6e4
    };
    if (forceIPv4) opts.family = 4;
    const req = mod.request(urlObj, opts, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBuffer(res.headers.location, headers, forceIPv4).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (c) => {
        chunks.push(c);
      });
      res.on("end", () => {
        resolve({ buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] });
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
async function getUnionId(clientId, clientSecret, staffId, log) {
  const cached = unionIdCache.get(staffId);
  if (cached) return cached;
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const res = await jsonPost2(
      `${DINGTALK_OAPI}/topapi/v2/user/get?access_token=${token}`,
      { userid: staffId, language: "zh_CN" }
    );
    if (res.errcode !== 0 || !res.result?.unionid) {
      log?.warn?.(`[dingtalk][quoted-file] Failed to get unionId for ${staffId}: ${res.errmsg || JSON.stringify(res)}`);
      return null;
    }
    const unionId = res.result.unionid;
    lruSet(unionIdCache, staffId, unionId, UNION_CACHE_MAX);
    return unionId;
  } catch (err) {
    log?.warn?.(`[dingtalk][quoted-file] getUnionId error: ${err}`);
    return null;
  }
}
async function getSpaceId(clientId, clientSecret, openConversationId, unionId, log) {
  const cacheKey = `${openConversationId}:${unionId}`;
  const cached = spaceIdCache.get(cacheKey);
  if (cached) return cached;
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const res = await jsonPost2(
      `${DINGTALK_API}/convFile/conversations/spaces/query`,
      { openConversationId, unionId },
      { "x-acs-dingtalk-access-token": token }
    );
    const rawSpaceId = res.spaceId ?? res.space?.spaceId;
    if (!rawSpaceId) {
      log?.warn?.(`[dingtalk][quoted-file] Failed to get spaceId for conv=${openConversationId}: ${JSON.stringify(res).substring(0, 300)}`);
      return null;
    }
    const spaceId = String(rawSpaceId);
    lruSet(spaceIdCache, cacheKey, spaceId, SPACE_CACHE_MAX);
    return spaceId;
  } catch (err) {
    log?.warn?.(`[dingtalk][quoted-file] getSpaceId error: ${err}`);
    return null;
  }
}
async function findDentryByTime(clientId, clientSecret, spaceId, createdAt, log) {
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const headers = { "x-acs-dingtalk-access-token": token };
    let nextToken;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${DINGTALK_API}/storage/spaces/${spaceId}/dentries/listAll`);
      url.searchParams.set("maxResults", String(PAGE_SIZE));
      url.searchParams.set("orderType", "modifiedTimeDesc");
      if (nextToken) url.searchParams.set("nextToken", nextToken);
      const res = await jsonGet(url.toString(), headers);
      const items = res.items || res.dentries || [];
      for (const item of items) {
        const itemTime = item.createdTime ? new Date(item.createdTime).getTime() : item.createTime ?? 0;
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
async function getDownloadUrl(clientId, clientSecret, spaceId, dentryId, log) {
  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    const res = await jsonPost2(
      `${DINGTALK_API}/storage/spaces/${spaceId}/dentries/${dentryId}/downloadInfos/query`,
      {},
      { "x-acs-dingtalk-access-token": token }
    );
    const info = res.downloadInfo || res;
    const resourceUrl = info.resourceUrl || info.url;
    if (!resourceUrl) {
      log?.warn?.(`[dingtalk][quoted-file] No resourceUrl for dentry=${dentryId}: ${JSON.stringify(res).substring(0, 300)}`);
      return null;
    }
    const signedHeaders = {};
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
    return { url: resourceUrl, headers: Object.keys(signedHeaders).length > 0 ? signedHeaders : void 0 };
  } catch (err) {
    log?.warn?.(`[dingtalk][quoted-file] getDownloadUrl error: ${err}`);
    return null;
  }
}
var MIME_BY_EXT = {
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
  ".m4a": "audio/mp4"
};
async function downloadToTemp(resourceUrl, signedHeaders, name, log) {
  try {
    if (!fs3.existsSync(TEMP_DIR2)) fs3.mkdirSync(TEMP_DIR2, { recursive: true });
    let result;
    try {
      result = await downloadBuffer(resourceUrl, signedHeaders);
    } catch {
      log?.info?.("[dingtalk][quoted-file] CDN download failed, retrying IPv4-only");
      result = await downloadBuffer(resourceUrl, signedHeaders, true);
    }
    const ext = name ? path3.extname(name).toLowerCase() : "";
    const mimeType = result.contentType?.split(";")[0]?.trim() || MIME_BY_EXT[ext] || "application/octet-stream";
    let filename;
    if (name && path3.extname(name)) {
      const base = path3.basename(name, path3.extname(name)).replace(/[^\w\u4e00-\u9fa5.-]/g, "_").slice(0, 60);
      filename = `${base}_${Date.now()}${path3.extname(name)}`;
    } else {
      filename = `quoted_file_${Date.now()}${ext || ".bin"}`;
    }
    const filePath = path3.join(TEMP_DIR2, filename);
    fs3.writeFileSync(filePath, result.buffer);
    log?.info?.(`[dingtalk][quoted-file] Downloaded ${filePath} (${result.buffer.length} bytes, ${mimeType})`);
    return { path: filePath, mimeType };
  } catch (err) {
    log?.warn?.(`[dingtalk][quoted-file] Download failed: ${err}`);
    return null;
  }
}
async function resolveQuotedFile(config, params, log) {
  const { clientId, clientSecret } = config;
  if (!clientId || !clientSecret) return null;
  const { openConversationId, senderStaffId, fileCreatedAt } = params;
  if (!openConversationId || !senderStaffId || !fileCreatedAt) {
    log?.warn?.("[dingtalk][quoted-file] Missing required params: conv=" + openConversationId + " sender=" + senderStaffId + " ts=" + fileCreatedAt);
    return null;
  }
  const unionId = await getUnionId(clientId, clientSecret, senderStaffId, log);
  if (!unionId) return null;
  const spaceId = await getSpaceId(clientId, clientSecret, openConversationId, unionId, log);
  if (!spaceId) return null;
  const dentry = await findDentryByTime(clientId, clientSecret, spaceId, fileCreatedAt, log);
  if (!dentry) return null;
  const dlInfo = await getDownloadUrl(clientId, clientSecret, spaceId, dentry.dentryId, log);
  if (!dlInfo) return null;
  const media = await downloadToTemp(dlInfo.url, dlInfo.headers, dentry.name, log);
  if (!media) return null;
  return {
    media,
    spaceId,
    fileId: dentry.dentryId,
    name: dentry.name
  };
}

// src/monitor.ts
import * as fs4 from "fs";
import * as path4 from "path";
import * as os4 from "os";
var DEDUP_MAX_SIZE = 1e3;
var DEDUP_TTL_MS = 10 * 60 * 1e3;
var processedMessageIds = /* @__PURE__ */ new Map();
function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  return processedMessageIds.has(messageId);
}
function markMessageProcessed(messageId) {
  if (!messageId) return;
  processedMessageIds.set(messageId, Date.now());
  if (processedMessageIds.size > DEDUP_MAX_SIZE) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [id, ts] of processedMessageIds) {
      if (ts < cutoff) processedMessageIds.delete(id);
    }
    if (processedMessageIds.size > DEDUP_MAX_SIZE) {
      const overflow = processedMessageIds.size - DEDUP_MAX_SIZE;
      let removed = 0;
      for (const id of processedMessageIds.keys()) {
        if (removed >= overflow) break;
        processedMessageIds.delete(id);
        removed++;
      }
    }
  }
}
var CONTENT_DEDUP_WINDOW_MS = 2 * 60 * 1e3;
var CONTENT_DEDUP_MAX = 200;
var recentContentHashes = /* @__PURE__ */ new Map();
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i) | 0;
  }
  return h.toString(36);
}
function isContentDuplicate(senderId, text, log) {
  if (!senderId || !text || text.length < 4) return false;
  const key = `${senderId}:${simpleHash(text)}:${text.length}`;
  const prev = recentContentHashes.get(key);
  if (prev && Date.now() - prev < CONTENT_DEDUP_WINDOW_MS) {
    log?.info?.("[dingtalk] Content-level duplicate detected: sender=" + senderId + " len=" + text.length);
    return true;
  }
  return false;
}
function markContentProcessed(senderId, text) {
  if (!senderId || !text || text.length < 4) return;
  const key = `${senderId}:${simpleHash(text)}:${text.length}`;
  recentContentHashes.set(key, Date.now());
  if (recentContentHashes.size > CONTENT_DEDUP_MAX) {
    const cutoff = Date.now() - CONTENT_DEDUP_WINDOW_MS;
    for (const [k, ts] of recentContentHashes) {
      if (ts < cutoff) recentContentHashes.delete(k);
    }
  }
}
var SEND_THROTTLE_MS = 500;
var lastSendTime = 0;
async function throttleSend() {
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < SEND_THROTTLE_MS) {
    await new Promise((resolve) => setTimeout(resolve, SEND_THROTTLE_MS - elapsed));
  }
  lastSendTime = Date.now();
}
var MSG_CACHE_MAX = 500;
var MSG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var MSG_CACHE_FILE = path4.join(os4.homedir(), ".openclaw", "extensions", "dingtalk", ".cache", "msg-cache.json");
var msgCache = /* @__PURE__ */ new Map();
var outboundByTime = [];
var OUTBOUND_TIME_CACHE_MAX = 100;
var OUTBOUND_TIME_WINDOW_MS = 1e4;
function loadMsgCache() {
  try {
    if (fs4.existsSync(MSG_CACHE_FILE)) {
      const raw = fs4.readFileSync(MSG_CACHE_FILE, "utf-8");
      const entries = JSON.parse(raw);
      const cutoff = Date.now() - MSG_CACHE_TTL_MS;
      let loaded = 0;
      for (const [k, v] of entries) {
        if (v.ts > cutoff) {
          msgCache.set(k, v);
          loaded++;
        }
      }
      console.info(`[dingtalk] Loaded ${loaded} entries from msg cache (${MSG_CACHE_FILE})`);
    }
  } catch (err) {
    console.warn(`[dingtalk] Failed to load msg cache: ${err}`);
  }
}
var _saveCacheTimer = null;
function scheduleSaveCache() {
  if (_saveCacheTimer) return;
  _saveCacheTimer = setTimeout(() => {
    _saveCacheTimer = null;
    try {
      const dir = path4.dirname(MSG_CACHE_FILE);
      if (!fs4.existsSync(dir)) fs4.mkdirSync(dir, { recursive: true });
      const entries = [...msgCache.entries()];
      fs4.writeFileSync(MSG_CACHE_FILE, JSON.stringify(entries), "utf-8");
    } catch (err) {
      console.warn(`[dingtalk] Failed to save msg cache: ${err}`);
    }
  }, 2e3);
}
loadMsgCache();
function msgCacheSet(msgId, entry) {
  if (msgCache.size >= MSG_CACHE_MAX) {
    const cutoff = Date.now() - MSG_CACHE_TTL_MS;
    for (const [k, v] of msgCache) {
      if (v.ts < cutoff) msgCache.delete(k);
    }
    if (msgCache.size >= MSG_CACHE_MAX) {
      const oldest = [...msgCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) msgCache.delete(oldest[0]);
    }
  }
  msgCache.set(msgId, entry);
  scheduleSaveCache();
}
function cacheOutboundMessage(key, text) {
  if (!key || !text) return;
  const now = Date.now();
  msgCacheSet(key, { senderNick: "Jax", text, msgtype: "text", ts: now });
  outboundByTime.push({ ts: now, text });
  if (outboundByTime.length > OUTBOUND_TIME_CACHE_MAX) outboundByTime.shift();
}
function cacheOutboundMessageByTime(text) {
  if (!text) return;
  outboundByTime.push({ ts: Date.now(), text });
  if (outboundByTime.length > OUTBOUND_TIME_CACHE_MAX) outboundByTime.shift();
}
function resolveOutboundByTime(createdAt) {
  if (!createdAt || outboundByTime.length === 0) return void 0;
  let best;
  let bestDiff = Infinity;
  for (const entry of outboundByTime) {
    const diff = Math.abs(entry.ts - createdAt);
    if (diff < OUTBOUND_TIME_WINDOW_MS && diff < bestDiff) {
      best = entry;
      bestDiff = diff;
    }
  }
  return best?.text;
}
var messageBuffer = /* @__PURE__ */ new Map();
var AGGREGATION_DELAY_MS = 2e3;
var replyTargetCache = /* @__PURE__ */ new Map();
var REPLY_TARGET_CACHE_TTL_MS = 3 * 60 * 60 * 1e3;
function buildReplyTargetCacheKey(isDm, conversationId, senderId) {
  return isDm ? `dm:${senderId}` : `group:${conversationId}`;
}
function getCachedReplyTarget(cacheKey) {
  const entry = replyTargetCache.get(cacheKey);
  if (!entry) return void 0;
  if (Date.now() - entry._cachedAt > REPLY_TARGET_CACHE_TTL_MS) {
    replyTargetCache.delete(cacheKey);
    return void 0;
  }
  return entry;
}
var sessionQueues = /* @__PURE__ */ new Map();
var sessionQueueLastActivity = /* @__PURE__ */ new Map();
var DELIVER_ACTIVITY_GRACE_MS = 8e3;
var deliverActivityTimestamps = /* @__PURE__ */ new Map();
function markDeliverActivity(queueKey) {
  deliverActivityTimestamps.set(queueKey, Date.now());
}
function hasActiveDelivery(queueKey) {
  const ts = deliverActivityTimestamps.get(queueKey);
  if (!ts) return false;
  if (Date.now() - ts > DELIVER_ACTIVITY_GRACE_MS) {
    deliverActivityTimestamps.delete(queueKey);
    return false;
  }
  return true;
}
var SESSION_QUEUE_TTL_MS = 5 * 60 * 1e3;
function cleanupExpiredSessionQueues() {
  const now = Date.now();
  for (const [key, ts] of sessionQueueLastActivity) {
    if (now - ts > SESSION_QUEUE_TTL_MS && !sessionQueues.has(key)) {
      sessionQueueLastActivity.delete(key);
    }
  }
}
function getBufferKey(msg, accountId) {
  return `${accountId}:${msg.conversationId}:${msg.senderId || msg.senderStaffId}`;
}
async function startDingTalkMonitor(ctx) {
  const { account, cfg, abortSignal, log, setStatus } = ctx;
  if (!account.clientId || !account.clientSecret) {
    throw new Error("DingTalk clientId/clientSecret not configured");
  }
  cleanupOldMedia();
  const cleanupInterval = setInterval(() => {
    cleanupOldMedia();
  }, 60 * 60 * 1e3);
  const queueCleanupInterval = setInterval(cleanupExpiredSessionQueues, 6e4);
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      clearInterval(cleanupInterval);
      clearInterval(queueCleanupInterval);
      const prefix = account.accountId + ":";
      for (const key of sessionQueues.keys()) {
        if (key.startsWith(prefix)) sessionQueues.delete(key);
      }
      for (const key of sessionQueueLastActivity.keys()) {
        if (key.startsWith(prefix)) sessionQueueLastActivity.delete(key);
      }
    });
  }
  let DWClient;
  let TOPIC_ROBOT;
  try {
    const mod = await import("dingtalk-stream");
    DWClient = mod.DWClient || mod.default?.DWClient || mod.default;
    TOPIC_ROBOT = mod.TOPIC_ROBOT || mod.default?.TOPIC_ROBOT || "/v1.0/im/bot/messages/get";
  } catch (err) {
    throw new Error("Failed to import dingtalk-stream SDK: " + err);
  }
  if (!DWClient) throw new Error("DWClient not found in dingtalk-stream");
  log?.info?.("[dingtalk:" + account.accountId + "] Starting Stream...");
  const client = new DWClient({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    keepAlive: false,
    // Disabled: SDK's 8s ping/pong terminates on unreachable gateway endpoints
    autoReconnect: false
    // We manage reconnection with exponential backoff
  });
  const HEARTBEAT_CHECK_MS = 3e4;
  const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1e3;
  const RECONNECT_BASE_MS = 1e3;
  const RECONNECT_CAP_MS = 3e4;
  let reconnectAttempt = 0;
  let heartbeatTimer = null;
  let lastActivityTime = Date.now();
  const touchActivity = () => {
    lastActivityTime = Date.now();
  };
  client.registerCallbackListener(TOPIC_ROBOT, async (downstream) => {
    const protocolMsgId = downstream.headers?.messageId;
    try {
      client.socketCallBackResponse(protocolMsgId, { status: "SUCCESS" });
    } catch (_) {
    }
    touchActivity();
    if (isDuplicateMessage(protocolMsgId)) {
      log?.info?.("[dingtalk] Duplicate message skipped (protocol): " + protocolMsgId);
      return { status: "SUCCESS", message: "OK" };
    }
    markMessageProcessed(protocolMsgId);
    try {
      const data = typeof downstream.data === "string" ? JSON.parse(downstream.data) : downstream.data;
      const bizMsgId = data.msgId;
      if (bizMsgId && isDuplicateMessage("biz:" + bizMsgId)) {
        log?.info?.("[dingtalk] Duplicate message skipped (bizMsgId): " + bizMsgId);
        return { status: "SUCCESS", message: "OK" };
      }
      if (bizMsgId) markMessageProcessed("biz:" + bizMsgId);
      setStatus?.({ lastInboundAt: Date.now() });
      await processInboundMessage(data, ctx);
    } catch (err) {
      log?.info?.("[dingtalk] Message error: " + err);
    }
    return { status: "SUCCESS", message: "OK" };
  });
  client.registerAllEventListener((msg) => {
    touchActivity();
    return { status: "SUCCESS", message: "OK" };
  });
  while (!abortSignal?.aborted) {
    try {
      await client.connect();
      const connectTime = Date.now();
      lastActivityTime = connectTime;
      log?.info?.("[dingtalk:" + account.accountId + "] Stream connected");
      setStatus?.({ running: true, lastStartAt: connectTime });
      heartbeatTimer = setInterval(() => {
        const elapsed = Date.now() - lastActivityTime;
        if (elapsed > HEARTBEAT_TIMEOUT_MS) {
          log?.warn?.("[dingtalk] Heartbeat timeout (" + Math.round(elapsed / 1e3) + "s since last activity), forcing reconnect");
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          try {
            client.disconnect?.();
          } catch {
          }
        }
      }, HEARTBEAT_CHECK_MS);
      await new Promise((resolve) => {
        const pollTimer = setInterval(() => {
          if (!client.connected) {
            clearInterval(pollTimer);
            resolve();
          }
        }, 1e3);
        if (abortSignal) {
          abortSignal.addEventListener("abort", () => {
            clearInterval(pollTimer);
            resolve();
          }, { once: true });
        }
      });
      if (Date.now() - connectTime > 3e4) {
        reconnectAttempt = 0;
      }
    } catch (err) {
      log?.warn?.("[dingtalk] Connection error: " + (err instanceof Error ? err.message : String(err)));
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (abortSignal?.aborted) break;
    setStatus?.({ running: false });
    reconnectAttempt++;
    const backoff = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt - 1), RECONNECT_CAP_MS);
    const jitter = Math.random() * backoff * 0.3;
    const delay = Math.round(backoff + jitter);
    log?.info?.("[dingtalk] Reconnect attempt " + reconnectAttempt + " in " + delay + "ms");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }
    });
  }
  try {
    client.disconnect?.();
  } catch {
  }
  setStatus?.({ running: false, lastStopAt: Date.now() });
}
async function extractMessageContent(msg, account, log) {
  const msgtype = msg.msgtype || "text";
  const content = msg.content;
  switch (msgtype) {
    case "text": {
      return {
        text: msg.text?.content?.trim() ?? "",
        messageType: "text"
      };
    }
    case "richText": {
      const result = await extractRichTextContent(msg, account, log);
      return { ...result, messageType: "richText" };
    }
    case "picture": {
      return extractPictureContent(msg, log);
    }
    case "markdown": {
      const markdownText = content?.text?.trim() || "";
      const markdownTitle = content?.title?.trim() || "";
      const text = markdownText || markdownTitle || "[Markdown\u6D88\u606F]";
      log?.info?.("[dingtalk] Markdown message received (" + text.length + " chars)");
      return {
        text,
        messageType: "markdown"
      };
    }
    case "audio": {
      const recognition = content?.recognition;
      const downloadCode = content?.downloadCode;
      log?.info?.("[dingtalk] Audio message - recognition: " + (recognition || "(none)"));
      return {
        text: recognition || "[\u8BED\u97F3\u6D88\u606F]",
        mediaDownloadCode: downloadCode,
        mediaType: "audio",
        messageType: "audio"
      };
    }
    case "video": {
      const downloadCode = content?.downloadCode;
      log?.info?.("[dingtalk] Video message - downloadCode: " + (downloadCode || "(none)"));
      return {
        text: "[\u89C6\u9891]",
        mediaDownloadCode: downloadCode,
        mediaType: "video",
        messageType: "video"
      };
    }
    case "file": {
      const downloadCode = content?.downloadCode;
      const fileName = content?.fileName || "\u672A\u77E5\u6587\u4EF6";
      log?.info?.("[dingtalk] File message - fileName: " + fileName);
      return {
        text: `[\u6587\u4EF6: ${fileName}]`,
        mediaDownloadCode: downloadCode,
        mediaType: "file",
        mediaFileName: fileName,
        messageType: "file"
      };
    }
    case "link": {
      const linkContent = msg.link || content;
      log?.info?.("[dingtalk] link message received: " + JSON.stringify(linkContent));
      if (linkContent) {
        const title = linkContent.title || "";
        const text = linkContent.text || "";
        const messageUrl = linkContent.messageUrl || "";
        const picUrl = linkContent.picUrl || "";
        const parts = [];
        if (title) parts.push(`[\u94FE\u63A5] ${title}`);
        if (text) parts.push(text);
        if (messageUrl) parts.push(`\u94FE\u63A5: ${messageUrl}`);
        if (picUrl) parts.push(`\u914D\u56FE: ${picUrl}`);
        const resultText = parts.join("\n") || "[\u94FE\u63A5\u5361\u7247]";
        log?.info?.("[dingtalk] Extracted link message: " + resultText.slice(0, 100));
        return {
          text: resultText,
          messageType: "link"
        };
      }
      return {
        text: "[\u94FE\u63A5\u5361\u7247]",
        messageType: "link"
      };
    }
    case "chatRecord": {
      const chatRecordContent = content || msg.chatRecord;
      log?.info?.("[dingtalk] chatRecord message received");
      try {
        const chatRecordStr = chatRecordContent?.chatRecord;
        if (chatRecordStr && typeof chatRecordStr === "string") {
          const records = JSON.parse(chatRecordStr);
          if (Array.isArray(records) && records.length > 0) {
            const firstRecord = records[0];
            log?.info?.("[dingtalk] chatRecord first record keys: " + Object.keys(firstRecord).join(", "));
            log?.info?.("[dingtalk] chatRecord first record: " + JSON.stringify(firstRecord));
            const senderIds = [...new Set(
              records.map((r) => r.senderStaffId || (r.senderId && !r.senderId.startsWith("$:") ? r.senderId : null)).filter((id) => !!id)
            )].slice(0, 10);
            log?.info?.("[dingtalk] chatRecord senderIds for lookup: " + JSON.stringify(senderIds));
            let senderNameMap = /* @__PURE__ */ new Map();
            if (senderIds.length > 0 && account.clientId && account.clientSecret) {
              try {
                senderNameMap = await batchGetUserInfo(account.clientId, account.clientSecret, senderIds, 3e3);
                log?.info?.("[dingtalk] Resolved " + senderNameMap.size + " sender names from API");
              } catch (err) {
                log?.info?.("[dingtalk] Failed to resolve sender names: " + err);
              }
            }
            const formattedRecords = await Promise.all(records.map(async (record, idx) => {
              let sender = record.senderNick;
              if (!sender) {
                const lookupId = record.senderStaffId || record.senderId;
                if (lookupId) {
                  sender = senderNameMap.get(lookupId);
                }
                if (!sender && record.senderId?.startsWith("$:")) {
                  sender = "\u6210\u5458";
                }
              }
              sender = sender || "\u672A\u77E5";
              let msgContent;
              switch (record.msgType) {
                case "text":
                  msgContent = record.content || "[\u7A7A\u6D88\u606F]";
                  break;
                case "picture":
                case "image":
                  if (record.downloadCode && account.clientId && account.clientSecret) {
                    try {
                      const robotCode = account.robotCode || account.clientId;
                      const pictureResult = await downloadPicture(
                        account.clientId,
                        account.clientSecret,
                        robotCode,
                        record.downloadCode
                      );
                      if (pictureResult.filePath) {
                        msgContent = `[\u56FE\u7247: ${pictureResult.filePath}]`;
                        log?.info?.("[dingtalk] Downloaded chatRecord picture: " + pictureResult.filePath);
                      } else if (pictureResult.error) {
                        msgContent = `[\u56FE\u7247\u4E0B\u8F7D\u5931\u8D25: ${pictureResult.error}]`;
                      } else {
                        msgContent = "[\u56FE\u7247]";
                      }
                    } catch (err) {
                      log?.info?.("[dingtalk] Error downloading chatRecord picture: " + err);
                      msgContent = "[\u56FE\u7247]";
                    }
                  } else {
                    msgContent = "[\u56FE\u7247]";
                  }
                  break;
                case "video":
                  msgContent = "[\u89C6\u9891]";
                  break;
                case "file":
                  msgContent = "[\u6587\u4EF6]";
                  break;
                case "voice":
                case "audio":
                  msgContent = "[\u8BED\u97F3]";
                  break;
                case "richText":
                  msgContent = record.content || "[\u5BCC\u6587\u672C\u6D88\u606F]";
                  break;
                case "markdown":
                  msgContent = record.content || "[Markdown\u6D88\u606F]";
                  break;
                default:
                  msgContent = record.content || `[${record.msgType || "\u672A\u77E5"}\u6D88\u606F]`;
              }
              const time = record.createAt ? new Date(record.createAt).toLocaleString("zh-CN") : "";
              return `[${idx + 1}] ${sender}${time ? ` (${time})` : ""}: ${msgContent}`;
            }));
            const text = `[\u804A\u5929\u8BB0\u5F55\u5408\u96C6 - ${records.length}\u6761\u6D88\u606F]
${formattedRecords.join("\n")}`;
            log?.info?.("[dingtalk] Parsed chatRecord with " + records.length + " messages");
            return {
              text,
              messageType: "chatRecord"
            };
          }
        }
      } catch (e) {
        log?.info?.("[dingtalk] Failed to parse chatRecord: " + (e instanceof Error ? e.message : String(e)));
      }
      log?.info?.("[dingtalk] chatRecord structure not recognized, full msg: " + JSON.stringify(msg).slice(0, 500));
      return {
        text: "[\u804A\u5929\u8BB0\u5F55\u5408\u96C6]",
        messageType: "chatRecord"
      };
    }
    default: {
      const text = msg.text?.content?.trim() || "";
      if (!text) {
        log?.info?.("[dingtalk] Unknown msgtype: " + msgtype + ", no text content found");
        log?.info?.("[dingtalk] Unknown msgtype full structure: " + JSON.stringify(msg).slice(0, 1e3));
      }
      return {
        text: text || `[${msgtype}\u6D88\u606F]`,
        messageType: msgtype
      };
    }
  }
}
async function extractRichTextContent(msg, account, log) {
  let text = msg.text?.content?.trim() ?? "";
  if (!text && msg.richText) {
    try {
      const richTextStr = typeof msg.richText === "string" ? msg.richText : JSON.stringify(msg.richText);
      log?.info?.("[dingtalk] Received richText message (full): " + richTextStr);
      const rt = msg.richText;
      if (typeof msg.richText === "string") {
        text = msg.richText.trim();
      } else if (rt) {
        text = rt.text?.trim() || rt.content?.trim() || rt.richText?.trim() || "";
        if (!text && Array.isArray(rt.richText)) {
          const textParts = [];
          for (const item of rt.richText) {
            if (item.text) {
              textParts.push(item.text);
            } else if (item.content) {
              textParts.push(item.content);
            }
          }
          text = textParts.join("").trim();
        }
      }
      if (text) {
        log?.info?.("[dingtalk] Extracted from richText: " + text.slice(0, 100));
      }
    } catch (err) {
      log?.info?.("[dingtalk] Failed to parse richText: " + err);
    }
  }
  if (!text) {
    const content = msg.content;
    if (content?.richText && Array.isArray(content.richText)) {
      log?.info?.("[dingtalk] RichText message - msg.content: " + JSON.stringify(content).substring(0, 200));
      const parts = [];
      for (const item of content.richText) {
        if (item.msgType === "text" && item.content) {
          parts.push(item.content);
        } else if (item.text) {
          parts.push(item.text);
        } else if (item.msgType === "quote" || item.type === "quote") {
          const quotedText = item.content?.text || (typeof item.content === "string" ? item.content : null) || item.text || "";
          const quotedSender = item.content?.senderNick || item.senderNick || "";
          if (quotedText) {
            const senderPrefix = quotedSender ? `${quotedSender}: ` : "";
            parts.push(`[\u5F15\u7528: "${senderPrefix}${String(quotedText).trim().substring(0, 120)}"]`);
            log?.info?.("[dingtalk] Extracted quote item from richText array: " + String(quotedText).substring(0, 60));
          } else {
            log?.info?.("[dingtalk] Quote item in richText but no text content: " + JSON.stringify(item).substring(0, 200));
          }
        } else if ((item.msgType === "picture" || item.pictureDownloadCode || item.downloadCode) && (item.downloadCode || item.pictureDownloadCode)) {
          const downloadCode = item.downloadCode || item.pictureDownloadCode;
          try {
            const robotCode = account.robotCode || account.clientId;
            const pictureResult = await downloadPicture(
              account.clientId,
              account.clientSecret,
              robotCode,
              downloadCode
            );
            if (pictureResult.filePath) {
              parts.push(`[\u56FE\u7247: ${pictureResult.filePath}]`);
              log?.info?.("[dingtalk] Downloaded picture from richText: " + pictureResult.filePath);
            } else if (pictureResult.error) {
              parts.push(`[\u56FE\u7247\u4E0B\u8F7D\u5931\u8D25: ${pictureResult.error}]`);
            } else {
              parts.push("[\u56FE\u7247]");
            }
          } catch (err) {
            parts.push(`[\u56FE\u7247\u4E0B\u8F7D\u51FA\u9519: ${err}]`);
            log?.warn?.("[dingtalk] Error downloading picture from richText: " + err);
          }
        }
      }
      text = parts.join("");
      if (text) {
        log?.info?.("[dingtalk] Extracted from msg.content.richText: " + text.substring(0, 100));
      }
    }
  }
  return { text };
}
function extractPictureContent(msg, log) {
  log?.info?.("[dingtalk] Picture message - msg.picture: " + JSON.stringify(msg.picture));
  log?.info?.("[dingtalk] Picture message - msg.content: " + JSON.stringify(msg.content));
  const content = msg.content;
  let downloadCode;
  if (msg.picture?.downloadCode) {
    downloadCode = msg.picture.downloadCode;
  } else if (content?.downloadCode) {
    downloadCode = content.downloadCode;
  }
  if (downloadCode) {
    log?.info?.("[dingtalk] Picture detected, downloadCode: " + downloadCode);
    return {
      text: "[\u7528\u6237\u53D1\u9001\u4E86\u56FE\u7247]",
      mediaDownloadCode: downloadCode,
      mediaType: "image",
      messageType: "picture"
    };
  }
  log?.info?.("[dingtalk] Picture msgtype but no downloadCode found");
  return {
    text: "[\u7528\u6237\u53D1\u9001\u4E86\u56FE\u7247(\u65E0\u6CD5\u83B7\u53D6\u4E0B\u8F7D\u7801)]",
    messageType: "picture"
  };
}
async function processInboundMessage(msg, ctx) {
  const { account, cfg, log, setStatus } = ctx;
  const runtime = getDingTalkRuntime();
  const isDm = msg.conversationType === "1";
  const isGroup = msg.conversationType === "2";
  {
    const hasQuoteIndicators = msg.text?.isReplyMsg || !!msg.quoteMsg || !!msg.content?.quote || msg.msgtype === "richText";
    if (msg.msgtype === "richText" || msg.picture || msg.atUsers && msg.atUsers.length > 0 || hasQuoteIndicators) {
      log?.info?.("[dingtalk-debug] Full message structure:");
      log?.info?.("[dingtalk-debug]   msgtype: " + msg.msgtype);
      log?.info?.("[dingtalk-debug]   text: " + JSON.stringify(msg.text));
      log?.info?.("[dingtalk-debug]   richText: " + JSON.stringify(msg.richText));
      log?.info?.("[dingtalk-debug]   picture: " + JSON.stringify(msg.picture));
      log?.info?.("[dingtalk-debug]   atUsers: " + JSON.stringify(msg.atUsers));
      log?.info?.("[dingtalk-debug]   RAW MESSAGE: " + JSON.stringify(msg).substring(0, 800));
    } else {
      const msgKeys = Object.keys(msg).filter((k) => !["conversationId", "chatbotCorpId", "chatbotUserId", "msgId", "senderNick", "isAdmin", "senderStaffId", "sessionWebhookExpiredTime", "createAt", "senderCorpId", "conversationType", "senderId", "sessionWebhook", "robotCode"].includes(k));
      log?.info?.("[dingtalk-debug] text msg extra fields: " + JSON.stringify(msgKeys) + " | " + JSON.stringify(msg).substring(0, 400));
    }
  }
  const extracted = await extractMessageContent(msg, account, log);
  let mediaPath;
  let mediaType;
  const skipMediaDownload = extracted.messageType === "audio" && !!extracted.text;
  if (!skipMediaDownload && extracted.mediaDownloadCode && account.clientId && account.clientSecret) {
    const robotCode = account.robotCode || account.clientId;
    try {
      const result = await downloadMediaFile(
        account.clientId,
        account.clientSecret,
        robotCode,
        extracted.mediaDownloadCode,
        extracted.mediaType,
        extracted.mediaFileName
        // preserve original filename for PDFs/Excel/etc
      );
      if (result.filePath) {
        mediaPath = result.filePath;
        mediaType = result.mimeType || extracted.mediaType;
        log?.info?.(`[dingtalk] Downloaded ${extracted.mediaType || "media"}: ${result.filePath}`);
      } else if (result.error) {
        log?.warn?.(`[dingtalk] Media download failed: ${result.error}`);
      }
    } catch (err) {
      log?.warn?.(`[dingtalk] Media download error: ${err}`);
    }
  } else if (skipMediaDownload) {
    log?.info?.("[dingtalk] Audio ASR text available, skipping .amr download");
  }
  if (extracted.mediaDownloadCode && msg.msgId && msg.conversationId && (extracted.messageType === "file" || extracted.messageType === "video" || extracted.messageType === "audio")) {
    cacheInboundDownloadCode(
      account.accountId,
      msg.conversationId,
      msg.msgId,
      extracted.mediaDownloadCode,
      extracted.messageType,
      msg.createAt
    );
  }
  let rawBody = extracted.text;
  const _hasOriginalMsgId = !!msg.originalMsgId || !!msg.originalProcessQueryKey;
  const _hasTopLevelQuote = !!msg.quoteMsg || !!msg.content?.quote || !!msg.content?.referenceMessage;
  const _isLikelyQuoteReply = msg.text?.isReplyMsg || _hasTopLevelQuote || _hasOriginalMsgId;
  if (!rawBody && !mediaPath && !_isLikelyQuoteReply) {
    log?.info?.("[dingtalk] Empty message body after all attempts, skipping. msgtype=" + msg.msgtype);
    return;
  }
  if (!rawBody?.trim() && !mediaPath) {
    log?.info?.("[dingtalk] Empty message body after quote resolution, skipping.");
    return;
  }
  if (!rawBody && mediaPath) {
    const fileLabel = extracted.mediaFileName ? `${extracted.mediaFileName} \u2192 ${mediaPath}` : mediaPath;
    rawBody = `[${extracted.messageType}] \u5A92\u4F53\u6587\u4EF6\u5DF2\u4E0B\u8F7D: ${fileLabel}`;
  }
  if (msg.msgId && rawBody) {
    msgCacheSet(msg.msgId, {
      senderNick: msg.senderNick || "",
      text: rawBody,
      msgtype: msg.msgtype,
      ts: Date.now()
    });
  }
  const topLevelQuoteMsg = msg.quoteMsg;
  const contentQuote = msg.content?.quote || msg.content?.referenceMessage;
  const isQuoteReply = msg.text && msg.text.isReplyMsg || !!topLevelQuoteMsg || !!contentQuote;
  if (isQuoteReply) {
    log?.info?.("[dingtalk] Quote reply detected. isReplyMsg=" + !!msg.text?.isReplyMsg + " | has quoteMsg=" + !!topLevelQuoteMsg + " | has contentQuote=" + !!contentQuote);
    log?.info?.("[dingtalk] Full message for quote debug: " + JSON.stringify(msg).substring(0, 1500));
    const repliedMsgSource = msg.text?.repliedMsg || topLevelQuoteMsg || contentQuote;
    const originalMsgId = msg.originalMsgId;
    const originalProcessQueryKey = msg.originalProcessQueryKey;
    const cachedQuoted = (originalMsgId ? msgCache.get(originalMsgId) : void 0) || (originalProcessQueryKey ? msgCache.get(originalProcessQueryKey) : void 0);
    if (cachedQuoted) {
      const resolvedBy = originalMsgId && msgCache.has(originalMsgId) ? `msgId=${originalMsgId}` : `pqk=${originalProcessQueryKey}`;
      log?.info?.("[dingtalk] Quote reply resolved from cache (" + resolvedBy + ") sender=" + cachedQuoted.senderNick);
      const senderTag = cachedQuoted.senderNick ? ` (${cachedQuoted.senderNick})` : "";
      rawBody = `[\u5F15\u7528\u56DE\u590D${senderTag}: "${cachedQuoted.text.trim().substring(0, 200)}"]
${rawBody}`;
    } else if (repliedMsgSource) {
      try {
        const repliedMsg = repliedMsgSource;
        let quotedContent = "";
        if (repliedMsg.content?.richText && Array.isArray(repliedMsg.content.richText)) {
          const parts = [];
          for (const item of repliedMsg.content.richText) {
            if (item.msgType === "text" && item.content) {
              parts.push(item.content);
            } else if (item.msgType === "picture" && item.downloadCode) {
              try {
                const robotCode = account.robotCode || account.clientId;
                const pictureResult = await downloadPicture(
                  account.clientId,
                  account.clientSecret,
                  robotCode,
                  item.downloadCode
                );
                if (pictureResult.filePath) {
                  parts.push(`[\u56FE\u7247: ${pictureResult.filePath}]`);
                  log?.info?.("[dingtalk] Downloaded picture from quoted message: " + pictureResult.filePath);
                } else if (pictureResult.error) {
                  parts.push(`[\u56FE\u7247\u4E0B\u8F7D\u5931\u8D25: ${pictureResult.error}]`);
                } else {
                  parts.push("[\u56FE\u7247]");
                }
              } catch (err) {
                parts.push(`[\u56FE\u7247\u4E0B\u8F7D\u51FA\u9519: ${err}]`);
                log?.warn?.("[dingtalk] Error downloading picture from quoted message: " + err);
              }
            }
          }
          quotedContent = parts.join("");
        } else if (repliedMsg.content?.text) {
          quotedContent = repliedMsg.content.text;
        } else if (typeof repliedMsg.content === "string") {
          quotedContent = repliedMsg.content;
        } else if (repliedMsg.text && typeof repliedMsg.text === "string") {
          quotedContent = repliedMsg.text;
        } else if (repliedMsg.text?.content) {
          quotedContent = repliedMsg.text.content;
        } else if (repliedMsg.body) {
          quotedContent = typeof repliedMsg.body === "string" ? repliedMsg.body : JSON.stringify(repliedMsg.body);
        } else if (typeof repliedMsg === "string") {
          quotedContent = repliedMsg;
        }
        const quoteSender = repliedMsg.senderNick || repliedMsg.senderName || repliedMsg.content?.senderNick || "";
        if (quotedContent) {
          const senderTag = quoteSender ? ` (${quoteSender})` : "";
          rawBody = `[\u5F15\u7528\u56DE\u590D${senderTag}: "${quotedContent.trim()}"]
${rawBody}`;
          log?.info?.("[dingtalk] Added quoted message: " + quotedContent.slice(0, 50));
        } else if (repliedMsg.msgType === "interactiveCard" && repliedMsg.createdAt) {
          const timeResolved = resolveOutboundByTime(repliedMsg.createdAt);
          if (timeResolved) {
            rawBody = `[\u5F15\u7528\u56DE\u590D (Jax): "${timeResolved.trim().substring(0, 200)}"]
${rawBody}`;
            log?.info?.("[dingtalk] Resolved interactiveCard quote via timestamp (createdAt=" + repliedMsg.createdAt + "): " + timeResolved.slice(0, 50));
          } else {
            log?.warn?.("[dingtalk] interactiveCard quote: no timestamp match in outbound cache (createdAt=" + repliedMsg.createdAt + ", cache size=" + outboundByTime.length + ")");
          }
        } else if (["file", "video", "audio", "unknownMsgType"].includes(repliedMsg.msgType)) {
          log?.info?.("[dingtalk] Quoted file-type message (msgType=" + repliedMsg.msgType + "), attempting fallback resolution");
          const quoteSender2 = repliedMsg.senderNick || repliedMsg.senderName || "";
          const quoteMsgId = repliedMsg.msgId;
          let resolvedFile = false;
          const inlineDownloadCode = repliedMsg.content?.downloadCode || repliedMsg.downloadCode;
          if (inlineDownloadCode && account.clientId && account.clientSecret) {
            try {
              const robotCode = account.robotCode || account.clientId;
              const dlResult = await downloadMediaFile(
                account.clientId,
                account.clientSecret,
                robotCode,
                inlineDownloadCode,
                repliedMsg.msgType,
                repliedMsg.content?.fileName
              );
              if (dlResult.filePath) {
                if (!mediaPath) {
                  mediaPath = dlResult.filePath;
                  mediaType = dlResult.mimeType || repliedMsg.msgType;
                }
                const senderTag = quoteSender2 ? ` (${quoteSender2})` : "";
                rawBody = `[\u5F15\u7528\u6587\u4EF6${senderTag}: ${dlResult.filePath}]
${rawBody}`;
                resolvedFile = true;
                log?.info?.("[dingtalk] Quoted file resolved via inline downloadCode: " + dlResult.filePath);
              }
            } catch (err) {
              log?.warn?.("[dingtalk] Quoted file inline download failed: " + err);
            }
          }
          if (!resolvedFile && quoteMsgId && account.clientId && account.clientSecret) {
            const cached = getCachedDownloadCode(account.accountId, msg.conversationId, quoteMsgId);
            if (cached?.downloadCode) {
              try {
                const robotCode = account.robotCode || account.clientId;
                const dlResult = await downloadMediaFile(
                  account.clientId,
                  account.clientSecret,
                  robotCode,
                  cached.downloadCode,
                  cached.msgType
                );
                if (dlResult.filePath) {
                  if (!mediaPath) {
                    mediaPath = dlResult.filePath;
                    mediaType = dlResult.mimeType || cached.msgType;
                  }
                  const senderTag = quoteSender2 ? ` (${quoteSender2})` : "";
                  rawBody = `[\u5F15\u7528\u6587\u4EF6${senderTag}: ${dlResult.filePath}]
${rawBody}`;
                  resolvedFile = true;
                  log?.info?.("[dingtalk] Quoted file resolved via cache (downloadCode): " + dlResult.filePath);
                }
              } catch (err) {
                log?.warn?.("[dingtalk] Quoted file cache download failed: " + err);
              }
            }
          }
          if (!resolvedFile && account.clientId && account.clientSecret) {
            try {
              const fileResult = await resolveQuotedFile(
                { clientId: account.clientId, clientSecret: account.clientSecret },
                {
                  openConversationId: msg.conversationId,
                  // repliedMsg often lacks senderStaffId (DingTalk only provides encrypted senderId).
                  // Fall back to the outer message sender's staffId — any group member works for space query.
                  senderStaffId: repliedMsg.senderStaffId || msg.senderStaffId,
                  fileCreatedAt: repliedMsg.createdAt || repliedMsg.createAt
                },
                log
              );
              if (fileResult) {
                if (!mediaPath) {
                  mediaPath = fileResult.media.path;
                  mediaType = fileResult.media.mimeType;
                }
                const senderTag = quoteSender2 ? ` (${quoteSender2})` : "";
                const nameLabel = fileResult.name ? ` ${fileResult.name}` : "";
                rawBody = `[\u5F15\u7528\u6587\u4EF6${senderTag}:${nameLabel} ${fileResult.media.path}]
${rawBody}`;
                resolvedFile = true;
                if (quoteMsgId) {
                  cacheInboundDownloadCode(
                    account.accountId,
                    msg.conversationId,
                    quoteMsgId,
                    void 0,
                    repliedMsg.msgType,
                    repliedMsg.createdAt || repliedMsg.createAt || Date.now(),
                    { spaceId: fileResult.spaceId, fileId: fileResult.fileId }
                  );
                }
                log?.info?.("[dingtalk] Quoted file resolved via group file API: " + fileResult.media.path);
              }
            } catch (err) {
              log?.warn?.("[dingtalk] Quoted file group API fallback failed: " + err);
            }
          }
          if (!resolvedFile) {
            const senderTag = quoteSender2 ? ` (${quoteSender2})` : "";
            rawBody = `[\u5F15\u7528\u6587\u4EF6${senderTag}\uFF0C\u65E0\u6CD5\u83B7\u53D6\u5185\u5BB9]
${rawBody}`;
            log?.warn?.("[dingtalk] Quoted file could not be resolved, all fallbacks exhausted. msgType=" + repliedMsg.msgType + " msgId=" + (quoteMsgId || "unknown"));
          }
        } else {
          log?.warn?.("[dingtalk] Reply message found but no content extracted, repliedMsg keys: " + Object.keys(repliedMsg || {}).join(",") + " | full: " + JSON.stringify(repliedMsg).substring(0, 500));
        }
      } catch (err) {
        log?.info?.("[dingtalk] Failed to extract quoted message: " + err);
      }
    } else {
      log?.info?.("[dingtalk] Quote reply: no inline content and originalMsgId=" + (originalMsgId || "none") + " not in cache (cache size=" + msgCache.size + "). Full msg: " + JSON.stringify(msg).substring(0, 800));
    }
  }
  if (msg.atUsers && msg.atUsers.length > 0) {
    log?.info?.("[dingtalk] Message has @mentions: " + JSON.stringify(msg.atUsers));
    const userIds = msg.atUsers.filter((u) => u.staffId).map((u) => u.staffId).slice(0, 5);
    if (userIds.length > 0 && account.clientId && account.clientSecret) {
      try {
        const userInfoMap = await batchGetUserInfo(account.clientId, account.clientSecret, userIds, 3e3);
        if (userInfoMap.size > 0) {
          const mentions = Array.from(userInfoMap.values()).map((name) => `@${name}`).join(" ");
          rawBody = `[${mentions}] ${rawBody}`;
          log?.info?.("[dingtalk] Added user mentions: " + mentions);
        } else {
          rawBody = `[\u6709${msg.atUsers.length}\u4EBA\u88AB@] ${rawBody}`;
          log?.info?.("[dingtalk] User info fetch failed, using count fallback");
        }
      } catch (err) {
        rawBody = `[\u6709${msg.atUsers.length}\u4EBA\u88AB@] ${rawBody}`;
        log?.info?.("[dingtalk] Error fetching user info: " + err + ", using count fallback");
      }
    } else {
      rawBody = `[\u6709${msg.atUsers.length}\u4EBA\u88AB@] ${rawBody}`;
      log?.info?.("[dingtalk] No staffId or credentials, using count fallback");
    }
  }
  const senderId = msg.senderStaffId || msg.senderId;
  const senderName = msg.senderNick || "";
  const conversationId = msg.conversationId;
  log?.info?.("[dingtalk] " + (isDm ? "DM" : "Group") + " from " + senderName + ": " + rawBody.slice(0, 50));
  if (isDm) {
    const dmConfig = account.config.dm ?? {};
    if (dmConfig.enabled === false) return;
    const dmPolicy = dmConfig.policy ?? "pairing";
    if (dmPolicy === "disabled") return;
    if (dmPolicy !== "open") {
      const allowFrom = (dmConfig.allowFrom ?? []).map(String);
      if (!isSenderAllowed(senderId, allowFrom)) {
        log?.info?.("[dingtalk] DM denied for " + senderId);
        if (dmPolicy === "pairing" && msg.sessionWebhook) {
          await sendViaSessionWebhook(
            msg.sessionWebhook,
            "Access denied. Your staffId: " + senderId + "\nAsk admin to add you."
          ).catch(() => {
          });
        }
        return;
      }
    }
  }
  if (isGroup) {
    const groupPolicy = account.config.groupPolicy ?? "allowlist";
    if (groupPolicy === "disabled") return;
    if (groupPolicy === "allowlist") {
      const groupAllowlist = (account.config.groupAllowlist ?? []).map(String);
      if (groupAllowlist.length > 0 && !isGroupAllowed(conversationId, groupAllowlist)) {
        log?.info?.("[dingtalk] Group not in allowlist: " + conversationId);
        return;
      }
    }
    const requireMention = account.config.requireMention !== false;
    if (requireMention && !msg.isInAtList) return;
    const groupConfig = (account.config.groups ?? {})[conversationId];
    const groupAllowFrom = groupConfig?.allowFrom;
    if (groupAllowFrom && groupAllowFrom.length > 0) {
      log?.info?.("[dingtalk] Group allowFrom check: senderId=" + senderId + " allowFrom=" + JSON.stringify(groupAllowFrom));
      if (!isSenderAllowed(senderId, groupAllowFrom)) {
        log?.info?.("[dingtalk] Group sender not in allowFrom: " + senderId + " for group " + conversationId);
        return;
      }
    }
  }
  if (isContentDuplicate(senderId, rawBody, log)) {
    return;
  }
  markContentProcessed(senderId, rawBody);
  const sessionKey = "dingtalk:" + account.accountId + ":" + (isDm ? "dm" : "group") + ":" + conversationId;
  const replyTarget = {
    sessionWebhook: msg.sessionWebhook,
    sessionWebhookExpiry: msg.sessionWebhookExpiredTime,
    conversationId,
    senderId,
    isDm,
    account
  };
  const rtCacheKey = buildReplyTargetCacheKey(isDm, conversationId, senderId);
  replyTargetCache.set(rtCacheKey, { ...replyTarget, _cachedAt: Date.now() });
  const aggregationEnabled = account.config.messageAggregation !== false;
  const aggregationDelayMs = account.config.messageAggregationDelayMs ?? AGGREGATION_DELAY_MS;
  if (aggregationEnabled) {
    await bufferMessageForAggregation({
      msg,
      ctx,
      rawBody,
      replyTarget,
      sessionKey,
      isDm,
      senderId,
      senderName,
      conversationId,
      mediaPath,
      mediaType
    });
    return;
  }
  await dispatchMessage({
    ctx,
    msg,
    rawBody,
    replyTarget,
    sessionKey,
    isDm,
    senderId,
    senderName,
    conversationId,
    mediaPath,
    mediaType
  });
}
async function bufferMessageForAggregation(params) {
  const { msg, ctx, rawBody, replyTarget, sessionKey, isDm, senderId, senderName, conversationId, mediaPath, mediaType } = params;
  const { account, log } = ctx;
  const bufferKey = getBufferKey(msg, account.accountId);
  const aggregationDelayMs = account.config.messageAggregationDelayMs ?? AGGREGATION_DELAY_MS;
  const existing = messageBuffer.get(bufferKey);
  if (existing) {
    existing.messages.push({ text: rawBody, timestamp: Date.now(), mediaPath, mediaType });
    existing.msg = msg;
    existing.replyTarget = replyTarget;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      flushMessageBuffer(bufferKey);
    }, aggregationDelayMs);
    log?.info?.(`[dingtalk] Message buffered, total: ${existing.messages.length} messages`);
  } else {
    const newEntry = {
      messages: [{ text: rawBody, timestamp: Date.now(), mediaPath, mediaType }],
      timer: setTimeout(() => {
        flushMessageBuffer(bufferKey);
      }, aggregationDelayMs),
      ctx,
      msg,
      replyTarget,
      sessionKey,
      isDm,
      senderId,
      senderName,
      conversationId
    };
    messageBuffer.set(bufferKey, newEntry);
    log?.info?.(`[dingtalk] Message buffered (new), waiting ${aggregationDelayMs}ms for more...`);
  }
}
async function flushMessageBuffer(bufferKey) {
  const entry = messageBuffer.get(bufferKey);
  if (!entry) return;
  messageBuffer.delete(bufferKey);
  const { messages, ctx, msg, replyTarget, sessionKey, isDm, senderId, senderName, conversationId } = entry;
  const { log } = ctx;
  const combinedText = messages.map((m) => m.text).join("\n");
  const lastWithMedia = [...messages].reverse().find((m) => m.mediaPath);
  const mediaPath = lastWithMedia?.mediaPath;
  const mediaType = lastWithMedia?.mediaType;
  log?.info?.(`[dingtalk] Flushing buffer: ${messages.length} message(s) combined into ${combinedText.length} chars`);
  await dispatchMessage({
    ctx,
    msg,
    rawBody: combinedText,
    replyTarget,
    sessionKey,
    isDm,
    senderId,
    senderName,
    conversationId,
    mediaPath,
    mediaType
  });
}
function resolveQueueLane(text) {
  const t = text.trim();
  if (/^\/btw(\s|:|$)/i.test(t)) return ":btw";
  if (/^\/stop(\s|$)/i.test(t) || /^(stop|esc|abort|cancel|exit|halt|interrupt)$/i.test(t)) return ":control";
  if (/^\/(help|commands|tools|status|tasks|context)(\s|$)/i.test(t)) return ":control";
  return "";
}
async function dispatchMessage(params) {
  const { ctx, conversationId } = params;
  const { account, log } = ctx;
  const lane = resolveQueueLane(params.rawBody);
  const mainQueueKey = `${account.accountId}:${conversationId}`;
  const queueKey = `${mainQueueKey}${lane}`;
  const isQueueBusy = sessionQueues.has(queueKey) || lane === "" && hasActiveDelivery(mainQueueKey);
  let queueAckCleanup = null;
  if (isQueueBusy && lane === "") {
    log?.info?.("[dingtalk] Queue busy for " + queueKey + ", adding queue reaction");
    try {
      if (account.clientId && account.clientSecret && params.msg.msgId && conversationId) {
        const robotCode = account.robotCode || account.clientId;
        const result = await addEmotionReply({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode,
          msgId: params.msg.msgId,
          conversationId,
          emotionName: "\u23F3\u6392\u961F\u4E2D"
        });
        if (!result.error) {
          queueAckCleanup = result.cleanup;
        }
      }
    } catch (_) {
    }
  }
  const previousTask = sessionQueues.get(queueKey) || Promise.resolve();
  const currentTask = previousTask.then(async () => {
    if (queueAckCleanup) {
      try {
        await queueAckCleanup();
        log?.info?.("[dingtalk] Queue ack recalled, starting processing");
      } catch (_) {
      }
    }
    await dispatchMessageInternal(params);
  }).catch((err) => {
    log?.info?.("[dingtalk] Queued dispatch error: " + (err instanceof Error ? err.message : String(err)));
  }).finally(() => {
    sessionQueueLastActivity.set(queueKey, Date.now());
    if (sessionQueues.get(queueKey) === currentTask) {
      sessionQueues.delete(queueKey);
      log?.info?.("[dingtalk] Queue entry removed for " + queueKey + " (deliverActive=" + hasActiveDelivery(queueKey) + ")");
    }
  });
  sessionQueues.set(queueKey, currentTask);
  sessionQueueLastActivity.set(queueKey, Date.now());
  log?.info?.("[dingtalk] Queue entry set for " + queueKey + " (wasQueueBusy=" + isQueueBusy + ")");
}
async function dispatchMessageInternal(params) {
  const { ctx, msg, rawBody, replyTarget, sessionKey, isDm, senderId, senderName, conversationId, mediaPath, mediaType } = params;
  const { account, cfg, log, setStatus } = ctx;
  const runtime = getDingTalkRuntime();
  const isGroup = !isDm;
  let typingCleanup = null;
  if (account.config.typingIndicator !== false && account.clientId && account.clientSecret) {
    const robotCode = account.robotCode || account.clientId;
    let emotionOk = false;
    if (msg.msgId && conversationId) {
      try {
        const result = await addEmotionReply({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode,
          msgId: msg.msgId,
          conversationId
        });
        if (!result.error) {
          typingCleanup = result.cleanup;
          emotionOk = true;
          log?.info?.("[dingtalk] Emotion reaction added (will be recalled on reply)");
        } else {
          log?.info?.("[dingtalk] Emotion reaction failed: " + result.error + ", falling back to typing indicator");
        }
      } catch (err) {
        log?.info?.("[dingtalk] Emotion reaction error: " + err + ", falling back to typing indicator");
      }
    }
    if (!emotionOk) {
      try {
        const typingMessage = account.config.typingIndicatorMessage || "\u23F3 \u601D\u8003\u4E2D...";
        const result = await sendTypingIndicator({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode,
          userId: isDm ? senderId : void 0,
          conversationId: !isDm ? conversationId : void 0,
          message: typingMessage
        });
        if (!result.error) {
          typingCleanup = result.cleanup;
          log?.info?.("[dingtalk] Typing indicator sent (will be recalled on reply)");
        } else {
          log?.info?.("[dingtalk] Typing indicator failed: " + result.error);
        }
      } catch (err) {
        log?.info?.("[dingtalk] Typing indicator error: " + err);
      }
    }
  } else if (account.config.showThinking && replyTarget.sessionWebhook) {
    try {
      await sendViaSessionWebhook(replyTarget.sessionWebhook, "\u6B63\u5728\u601D\u8003...");
      log?.info?.("[dingtalk] Sent thinking indicator (legacy, non-recallable)");
    } catch (_) {
    }
  }
  let actualCfg = cfg;
  if (cfg && typeof cfg.loadConfig === "function") {
    try {
      actualCfg = await cfg.loadConfig();
    } catch (err) {
      log?.info?.("[dingtalk] Failed to load config: " + err);
    }
  }
  const hasFullPipeline = !!(runtime?.channel?.routing?.resolveAgentRoute && runtime?.channel?.reply?.finalizeInboundContext && runtime?.channel?.reply?.createReplyDispatcherWithTyping && runtime?.channel?.reply?.dispatchReplyFromConfig);
  let typingCleaned = false;
  const cleanupTyping = async () => {
    if (typingCleanup && !typingCleaned) {
      typingCleaned = true;
      try {
        await typingCleanup();
        log?.info?.("[dingtalk] Thinking feedback recalled");
      } catch (err) {
        log?.info?.("[dingtalk] Failed to recall thinking feedback: " + err);
      }
    }
  };
  try {
    if (hasFullPipeline) {
      await dispatchWithFullPipeline({
        runtime,
        msg,
        rawBody,
        account,
        cfg: actualCfg,
        sessionKey,
        isDm,
        senderId,
        senderName,
        conversationId,
        replyTarget,
        mediaPath,
        mediaType,
        log,
        setStatus,
        onFirstReply: cleanupTyping
      });
    } else if (runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
      const _fallbackGroupsConfig = account?.config?.groups ?? {};
      const _fallbackCustomPrompt = isGroup ? _fallbackGroupsConfig?.[conversationId]?.systemPrompt?.trim() || void 0 : void 0;
      const _AT_HINT = 'To @mention someone in this group, use <at:STAFFID> in your reply (e.g. "<at:0164546066>\u8BF7\u67E5\u770B"). Look up staffId with "dws contact user search --query NAME --format json". Do NOT write @Name \u2014 only <at:STAFFID> with angle brackets triggers a real DingTalk @mention. The sender is auto-@mentioned.';
      const _fallbackGroupSystemPrompt = isGroup ? _fallbackCustomPrompt ? `${_fallbackCustomPrompt}

${_AT_HINT}` : _AT_HINT : void 0;
      const ctxPayload = {
        Body: rawBody,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: "dingtalk:" + senderId,
        To: isDm ? "dingtalk:" + account.accountId + ":dm:" + senderId : "dingtalk:" + account.accountId + ":group:" + conversationId,
        SessionKey: sessionKey,
        AccountId: account.accountId,
        ChatType: isDm ? "direct" : "group",
        ConversationLabel: isDm ? senderName : msg.conversationTitle ?? conversationId,
        SenderName: senderName || void 0,
        SenderId: senderId,
        WasMentioned: isGroup ? msg.isInAtList : void 0,
        Provider: "dingtalk",
        Surface: "dingtalk",
        MessageSid: msg.msgId,
        OriginatingChannel: "dingtalk",
        OriginatingTo: "dingtalk:" + conversationId,
        MediaPath: mediaPath,
        MediaType: mediaType,
        MediaUrl: mediaPath,
        GroupSystemPrompt: _fallbackGroupSystemPrompt
      };
      const fallbackQueueKey = `${account.accountId}:${conversationId}`;
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: actualCfg,
        dispatcherOptions: {
          deliver: async (payload) => {
            markDeliverActivity(fallbackQueueKey);
            await cleanupTyping();
            log?.info?.("[dingtalk] Deliver payload keys: " + Object.keys(payload || {}).join(",") + " text?=" + typeof payload?.text + " markdown?=" + typeof payload?.markdown);
            const textToSend = resolveDeliverText(payload, log);
            if (textToSend) {
              await deliverReply(replyTarget, textToSend, log);
              setStatus?.({ lastOutboundAt: Date.now() });
            } else {
              log?.info?.("[dingtalk] Deliver: no text resolved from payload");
            }
          },
          onError: (err) => {
            cleanupTyping().catch(() => {
            });
            log?.info?.("[dingtalk] Reply error: " + err);
          }
        }
      });
      runtime.channel?.activity?.record?.("dingtalk", account.accountId, "message");
    } else {
      log?.info?.("[dingtalk] Runtime dispatch not available");
      await cleanupTyping();
    }
  } catch (err) {
    await cleanupTyping();
    log?.info?.("[dingtalk] Dispatch error: " + err);
  }
}
async function dispatchWithFullPipeline(params) {
  const {
    runtime: rt,
    msg,
    rawBody,
    account,
    cfg,
    isDm,
    senderId,
    senderName,
    conversationId,
    replyTarget,
    log,
    setStatus,
    onFirstReply
  } = params;
  let firstReplyFired = false;
  const peerId = isDm ? senderId : conversationId;
  const peerKind = isDm ? "dm" : "group";
  const chatType = isDm ? "direct" : "group";
  let matchedAgentId = null;
  const bindings = cfg?.bindings;
  if (Array.isArray(bindings) && bindings.length > 0) {
    for (const binding of bindings) {
      const match = binding.match;
      if (!match) continue;
      if (match.channel && match.channel !== "dingtalk") continue;
      if (match.accountId && match.accountId !== account.accountId) continue;
      if (match.peer) {
        if (match.peer.kind && match.peer.kind !== chatType) continue;
        if (match.peer.id && match.peer.id !== "*" && match.peer.id !== peerId) continue;
      }
      matchedAgentId = binding.agentId;
      break;
    }
  }
  if (!matchedAgentId) {
    matchedAgentId = cfg?.defaultAgent || "main";
  }
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: "dingtalk",
    accountId: account.accountId,
    agentId: matchedAgentId,
    peer: { kind: peerKind, id: `${account.accountId}:${peerId}` }
  });
  const sessionKey = route.sessionKey;
  log?.info?.(`[dingtalk] Route resolved: agentId=${matchedAgentId} sessionKey=${sessionKey} accountId=${account.accountId}`);
  const storePath = rt.channel.session?.resolveStorePath?.(cfg?.session?.store, { agentId: matchedAgentId });
  const envelopeOptions = rt.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};
  const previousTimestamp = rt.channel.session?.readSessionUpdatedAt?.({ storePath, sessionKey });
  const fromLabel = isDm ? `${senderName} (${senderId})` : `${msg.conversationTitle || conversationId} - ${senderName}`;
  const body = rt.channel.reply.formatInboundEnvelope?.({
    channel: "DingTalk",
    from: fromLabel,
    timestamp: msg.createAt,
    body: rawBody,
    chatType: isDm ? "direct" : "group",
    sender: { name: senderName, id: senderId },
    previousTimestamp,
    envelope: envelopeOptions
  }) ?? rawBody;
  const to = isDm ? `dingtalk:${account.accountId}:dm:${senderId}` : `dingtalk:${account.accountId}:group:${conversationId}`;
  const groupsConfig = account?.config?.groups ?? {};
  const groupOverride = !isDm ? groupsConfig?.[conversationId] ?? {} : {};
  const AT_MENTION_HINT = 'To @mention someone in this group, use <at:STAFFID> in your reply (e.g. "<at:0164546066>\u8BF7\u67E5\u770B"). Look up staffId with "dws contact user search --query NAME --format json". Do NOT write @Name \u2014 only <at:STAFFID> with angle brackets triggers a real DingTalk @mention. The sender is auto-@mentioned.';
  const customGroupPrompt = !isDm ? groupOverride?.systemPrompt?.trim() || void 0 : void 0;
  const groupSystemPrompt = !isDm ? customGroupPrompt ? `${customGroupPrompt}

${AT_MENTION_HINT}` : AT_MENTION_HINT : void 0;
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: to,
    To: to,
    SessionKey: sessionKey,
    AccountId: account.accountId,
    ChatType: isDm ? "direct" : "group",
    ConversationLabel: fromLabel,
    GroupSubject: isDm ? void 0 : msg.conversationTitle || conversationId,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "dingtalk",
    Surface: "dingtalk",
    MessageSid: msg.msgId,
    Timestamp: msg.createAt,
    MediaPath: params.mediaPath,
    MediaType: params.mediaType,
    MediaUrl: params.mediaPath,
    CommandAuthorized: true,
    OriginatingChannel: "dingtalk",
    OriginatingTo: to,
    GroupSystemPrompt: groupSystemPrompt
  });
  if (rt.channel.session?.recordInboundSession) {
    await rt.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctx.SessionKey || sessionKey,
      ctx,
      updateLastRoute: isDm ? { sessionKey: route.mainSessionKey, channel: "dingtalk", to: senderId, accountId: account.accountId } : void 0
    });
  }
  const deliverQueueKey = `${account.accountId}:${conversationId}`;
  const { dispatcher, replyOptions, markDispatchIdle } = rt.channel.reply.createReplyDispatcherWithTyping({
    responsePrefix: "",
    deliver: async (payload) => {
      markDeliverActivity(deliverQueueKey);
      if (!firstReplyFired && onFirstReply) {
        firstReplyFired = true;
        await onFirstReply().catch((err) => {
          log?.info?.("[dingtalk] onFirstReply error: " + err);
        });
      }
      try {
        log?.info?.("[dingtalk] Pipeline deliver payload keys: " + Object.keys(payload || {}).join(",") + " text?=" + typeof payload?.text + " markdown?=" + typeof payload?.markdown);
        const textToSend = resolveDeliverText(payload, log);
        if (!textToSend) {
          log?.info?.("[dingtalk] Pipeline deliver: no text resolved from payload");
          return { ok: true };
        }
        await deliverReply(replyTarget, textToSend, log);
        setStatus?.({ lastOutboundAt: Date.now() });
        return { ok: true };
      } catch (err) {
        log?.info?.("[dingtalk] Reply delivery failed: " + err.message);
        return { ok: false, error: err.message };
      }
    }
  });
  try {
    log?.info?.("[dingtalk] dispatchReplyFromConfig started for " + deliverQueueKey);
    await rt.channel.reply.dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions });
    log?.info?.("[dingtalk] dispatchReplyFromConfig completed for " + deliverQueueKey);
  } finally {
    try {
      if (typeof dispatcher.markComplete === "function") {
        dispatcher.markComplete();
      }
      await dispatcher.waitForIdle();
      log?.info?.("[dingtalk] dispatcher.waitForIdle completed for " + deliverQueueKey);
    } catch (err) {
      log?.info?.("[dingtalk] dispatcher settle error: " + err);
    }
    markDispatchIdle();
  }
  rt.channel?.activity?.record?.("dingtalk", account.accountId, "message");
}
function resolveDeliverText(payload, log) {
  let text = typeof payload.markdown === "string" && payload.markdown || payload.text;
  if (text != null && typeof text !== "string") {
    log?.info?.("[dingtalk] Deliver payload has non-string text type=" + typeof text + ", payload keys=" + Object.keys(payload).join(","));
    text = String(text);
  }
  const mediaUrl = payload.mediaUrl || payload.media || payload.imageUrl || payload.image;
  if (mediaUrl && typeof mediaUrl === "string" && mediaUrl.startsWith("http")) {
    log?.info?.("[dingtalk] Deliver payload includes media URL: " + mediaUrl);
    const imageMarkdown = `![image](${mediaUrl})`;
    text = text ? `${text}

${imageMarkdown}` : imageMarkdown;
  }
  return text || void 0;
}
function buildMarkdownPreviewTitle(text, fallback = "Jax") {
  if (!text) return fallback;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const raw of lines) {
    if (/^!\[[^\]]*\]\([^\)]+\)$/.test(raw)) continue;
    let title = raw.replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/, "").replace(/!\[[^\]]*\]\([^\)]+\)/g, "").replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/\s+/g, " ").trim();
    if (!title) continue;
    if (title.length > 36) title = title.slice(0, 36);
    return title;
  }
  return fallback;
}
async function deliverReply(target, text, log) {
  const now = Date.now();
  const chunkLimit = target.account.config.textChunkLimit ?? 2e3;
  const messageFormat = target.account.config.messageFormat ?? "text";
  const longTextMode = target.account.config.longTextMode ?? "chunk";
  const longTextThreshold = target.account.config.longTextThreshold ?? 4e3;
  if (longTextMode === "file" && text.length > longTextThreshold) {
    log?.info?.("[dingtalk] Text exceeds threshold (" + text.length + " > " + longTextThreshold + "), sending as file");
    if (target.account.clientId && target.account.clientSecret) {
      const fileSent = await sendTextAsFile(target, text, log);
      if (fileSent) {
        return;
      }
      log?.info?.("[dingtalk] File send failed, falling back to chunked text");
    } else {
      log?.info?.("[dingtalk] No credentials for file send, falling back to chunked text");
    }
  }
  let isMarkdown;
  if (messageFormat === "auto") {
    isMarkdown = detectMarkdownContent(text);
    log?.info?.("[dingtalk] Auto-detected format: " + (isMarkdown ? "markdown" : "text"));
  } else {
    isMarkdown = messageFormat === "markdown" || messageFormat === "richtext";
  }
  let processedText = text;
  if (isMarkdown) {
    processedText = convertMarkdownTables(text);
    processedText = convertImageUrlsToMarkdown(processedText);
  }
  processedText = fixEmojiCjkSpacing(processedText);
  const chunks = [];
  if (processedText.length <= chunkLimit) {
    chunks.push(processedText);
  } else {
    for (let i = 0; i < processedText.length; i += chunkLimit) {
      chunks.push(processedText.slice(i, i + chunkLimit));
    }
  }
  const explicitAtIds = [];
  const atPattern = /<at:([a-zA-Z0-9_]+)>/g;
  for (let i = 0; i < chunks.length; i++) {
    let match;
    while ((match = atPattern.exec(chunks[i])) !== null) {
      if (!explicitAtIds.includes(match[1])) explicitAtIds.push(match[1]);
    }
    chunks[i] = chunks[i].replace(atPattern, "").replace(/  +/g, " ").trim();
  }
  if (explicitAtIds.length > 0) {
    log?.info?.("[dingtalk] Explicit @mentions parsed: " + JSON.stringify(explicitAtIds));
  }
  const atUserIds = [...explicitAtIds];
  if (!target.isDm && target.senderId && !atUserIds.includes(target.senderId)) {
    atUserIds.push(target.senderId);
  }
  let atApplied = false;
  for (const chunk of chunks) {
    let webhookSuccess = false;
    const maxRetries = 2;
    if (target.sessionWebhook && now < target.sessionWebhookExpiry - 6e4) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await throttleSend();
          log?.info?.("[dingtalk] Using sessionWebhook (attempt " + attempt + "/" + maxRetries + "), format=" + messageFormat);
          log?.info?.("[dingtalk] Sending text (" + chunk.length + " chars): " + chunk.substring(0, 200));
          const currentAt = !atApplied && atUserIds.length > 0 ? atUserIds : void 0;
          let sendResult;
          if (isMarkdown) {
            const markdownTitle = buildMarkdownPreviewTitle(chunk, "Jax");
            sendResult = await sendMarkdownViaSessionWebhook(target.sessionWebhook, markdownTitle, chunk, currentAt);
          } else {
            sendResult = await sendViaSessionWebhook(target.sessionWebhook, chunk, currentAt);
          }
          if (!sendResult.ok) {
            throw new Error(`SessionWebhook rejected: errcode=${sendResult.errcode}, errmsg=${sendResult.errmsg}`);
          }
          log?.info?.("[dingtalk] SessionWebhook send OK (errcode=" + (sendResult.errcode ?? 0) + (sendResult.processQueryKey ? ` pqk=${sendResult.processQueryKey}` : "") + ")");
          if (sendResult.processQueryKey) {
            cacheOutboundMessage(sendResult.processQueryKey, chunk);
          } else {
            cacheOutboundMessageByTime(chunk);
          }
          if (currentAt) atApplied = true;
          webhookSuccess = true;
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log?.info?.("[dingtalk] SessionWebhook attempt " + attempt + " failed: " + errMsg);
          if (errMsg.includes("880001") || errMsg.includes("invalid session") || errMsg.includes("expired") || errMsg.includes("token is not exist")) {
            log?.info?.("[dingtalk] SessionWebhook expired/invalid, falling through to REST API");
            break;
          }
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 1e3));
          }
        }
      }
    }
    if (!webhookSuccess && target.account.clientId && target.account.clientSecret) {
      try {
        await throttleSend();
        log?.info?.("[dingtalk] SessionWebhook unavailable, using REST API fallback");
        const restResult = await sendDingTalkRestMessage({
          clientId: target.account.clientId,
          clientSecret: target.account.clientSecret,
          robotCode: target.account.robotCode || target.account.clientId,
          userId: target.isDm ? target.senderId : void 0,
          conversationId: !target.isDm ? target.conversationId : void 0,
          text: chunk,
          format: isMarkdown ? "markdown" : "text"
        });
        log?.info?.("[dingtalk] REST API send OK" + (restResult.processQueryKey ? ` pqk=${restResult.processQueryKey}` : ""));
        if (restResult.processQueryKey) {
          cacheOutboundMessage(restResult.processQueryKey, textChunk);
        }
      } catch (err) {
        log?.info?.("[dingtalk] REST API also failed: " + (err instanceof Error ? err.stack : JSON.stringify(err)));
      }
    } else if (!webhookSuccess) {
      log?.info?.("[dingtalk] No delivery method available!");
    }
  }
}
async function sendTextAsFile(target, text, log) {
  try {
    const { buffer, fileName } = textToMarkdownFile(text, "AI Response");
    log?.info?.("[dingtalk] Converting text to file: " + fileName + " (" + buffer.length + " bytes)");
    const uploadResult = await uploadMediaFile({
      clientId: target.account.clientId,
      clientSecret: target.account.clientSecret,
      robotCode: target.account.robotCode || target.account.clientId,
      fileBuffer: buffer,
      fileName,
      fileType: "file"
    });
    if (!uploadResult.mediaId) {
      log?.info?.("[dingtalk] File upload failed: " + (uploadResult.error || "no mediaId returned"));
      return false;
    }
    log?.info?.("[dingtalk] File uploaded, mediaId=" + uploadResult.mediaId);
    const sendResult = await sendFileMessage({
      clientId: target.account.clientId,
      clientSecret: target.account.clientSecret,
      robotCode: target.account.robotCode || target.account.clientId,
      userId: target.isDm ? target.senderId : void 0,
      conversationId: !target.isDm ? target.conversationId : void 0,
      mediaId: uploadResult.mediaId,
      fileName
    });
    if (!sendResult.ok) {
      log?.info?.("[dingtalk] File send failed: " + (sendResult.error || "unknown error"));
      return false;
    }
    log?.info?.("[dingtalk] File sent successfully");
    return true;
  } catch (err) {
    log?.info?.("[dingtalk] sendTextAsFile error: " + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}
function fixEmojiCjkSpacing(text) {
  const emojiRe = new RegExp("(\\p{Emoji_Presentation}|\\p{Extended_Pictographic})", "gu");
  const cjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]/;
  return text.replace(emojiRe, (emoji, _m, offset, str) => {
    const before = offset > 0 ? str[offset - 1] : "";
    const after = str[offset + emoji.length] ?? "";
    const padLeft = cjkRe.test(before) && before !== " " ? " " : "";
    const padRight = cjkRe.test(after) && after !== " " ? " " : "";
    return padLeft + emoji + padRight;
  });
}
function convertImageUrlsToMarkdown(text) {
  text = text.replace(/图(\d+):\s*(https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp)(\?[^\s]*)?)/gi, (match, num, url) => {
    return `![\u56FE${num}](${url})`;
  });
  text = text.replace(/(?<!\]\()(?:^|\s)(https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp)(\?[^\s]*)?)/gim, (match, url) => {
    if (match.startsWith("](")) return match;
    const leadingSpace = match.match(/^\s/);
    return (leadingSpace ? leadingSpace[0] : "") + `![image](${url.trim()})`;
  });
  return text;
}
function convertMarkdownTables(text) {
  const tableRegex = /(\|.+\|\n)+/g;
  return text.replace(tableRegex, (match) => {
    const lines = match.trim().split("\n");
    if (lines.length < 2) return match;
    const hasSeparator = lines.some((line) => /^[\s|:-]+$/.test(line.replace(/\|/g, "")));
    if (!hasSeparator) return match;
    let result = "\n```\n";
    for (const line of lines) {
      if (/^[\s|:-]+$/.test(line.replace(/\|/g, ""))) continue;
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c);
      result += cells.join("  |  ") + "\n";
    }
    result += "```\n";
    return result;
  });
}
function detectMarkdownContent(text) {
  return /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>|```|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)/m.test(text);
}
function isSenderAllowed(senderId, allowFrom) {
  if (allowFrom.includes("*")) return true;
  const normalized = senderId.trim().toLowerCase();
  return allowFrom.some((entry) => {
    const e = String(entry).trim().toLowerCase();
    return e === normalized;
  });
}
function isGroupAllowed(conversationId, allowlist) {
  if (allowlist.includes("*")) return true;
  const normalized = conversationId.trim().toLowerCase();
  return allowlist.some((entry) => {
    const e = String(entry).trim().toLowerCase();
    return e === normalized;
  });
}

// src/channel.ts
init_api();
init_probe();
function parseOutboundTo(to) {
  const parts = to.split(":");
  if (parts[0] === "dingtalk" && parts.length > 2) {
    parts.shift();
  }
  if (parts[0] === "dm" || parts[0] === "group") {
    return { type: parts[0], id: parts.slice(1).join(":") };
  }
  return { type: "dm", id: to };
}
var dingtalkPlugin = {
  id: "dingtalk",
  meta: {
    label: "DingTalk",
    selectionLabel: "DingTalk (\u9489\u9489)",
    detailLabel: "DingTalk",
    blurb: "DingTalk bot via Stream Mode (WebSocket)",
    aliases: ["dingding", "dd"],
    order: 75
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    // Supports images via markdown in sessionWebhook replies
    files: true,
    // Supports file upload and sending
    threads: false,
    reactions: false,
    mentions: true
  },
  config: {
    schema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          title: "Enable DingTalk",
          default: true
        },
        clientId: {
          type: "string",
          title: "Client ID (AppKey)",
          description: "DingTalk application AppKey"
        },
        clientSecret: {
          type: "string",
          title: "Client Secret (AppSecret)",
          description: "DingTalk application AppSecret",
          secret: true
        },
        robotCode: {
          type: "string",
          title: "Robot Code (Optional)",
          description: "Optional robot code, defaults to Client ID"
        },
        dm: {
          type: "object",
          title: "Direct Message Settings",
          properties: {
            enabled: {
              type: "boolean",
              title: "Enable DM",
              default: true
            },
            policy: {
              type: "string",
              title: "DM Access Policy",
              enum: ["disabled", "pairing", "allowlist", "open"],
              default: "pairing",
              description: "disabled=no DM, pairing=show staffId to add, allowlist=only allowed users, open=everyone"
            },
            allowFrom: {
              type: "array",
              title: "Allowed Staff IDs",
              items: { type: "string" },
              default: [],
              description: "List of staff IDs allowed to DM the bot"
            }
          }
        },
        groupPolicy: {
          type: "string",
          title: "Group Chat Policy",
          enum: ["disabled", "allowlist", "open"],
          default: "allowlist",
          description: "disabled=no groups, allowlist=specific groups, open=all groups"
        },
        groupAllowlist: {
          type: "array",
          title: "Allowed Group IDs",
          items: { type: "string" },
          default: [],
          description: 'List of conversation IDs for allowed groups (only used when groupPolicy is "allowlist")'
        },
        requireMention: {
          type: "boolean",
          title: "Require @ Mention in Groups",
          default: true,
          description: "If true, bot only responds when @mentioned in group chats"
        },
        messageFormat: {
          type: "string",
          title: "Message Format",
          enum: ["text", "markdown", "auto"],
          default: "text",
          description: "text=plain text, markdown=always markdown, auto=detect markdown features in response"
        },
        showThinking: {
          type: "boolean",
          title: "Show Thinking Indicator",
          default: false,
          description: 'Send "\u6B63\u5728\u601D\u8003..." feedback before AI processing begins'
        }
      },
      required: ["clientId", "clientSecret"]
    },
    listAccountIds(cfg) {
      return listDingTalkAccountIds(cfg);
    },
    resolveAccount(cfg, accountId) {
      return resolveDingTalkAccount({ cfg, accountId });
    },
    defaultAccountId(cfg) {
      return resolveDefaultDingTalkAccountId(cfg);
    },
    setAccountEnabled({ cfg, accountId, enabled }) {
      const runtime = getDingTalkRuntime();
      const channel = cfg?.channels?.dingtalk;
      if (channel?.accounts && accountId && accountId !== "default") {
        runtime.config.set(`channels.dingtalk.accounts.${accountId}.enabled`, enabled);
      } else {
        runtime.config.set("channels.dingtalk.enabled", enabled);
      }
    },
    deleteAccount({ cfg, accountId }) {
      const runtime = getDingTalkRuntime();
      const channel = cfg?.channels?.dingtalk;
      if (channel?.accounts && accountId && accountId !== "default") {
        runtime.config.delete(`channels.dingtalk.accounts.${accountId}`);
      } else {
        runtime.config.delete("channels.dingtalk");
      }
    },
    isConfigured(account) {
      return !!(account.clientId && account.clientSecret);
    },
    describeAccount(account) {
      return {
        accountId: account.accountId,
        name: account.name || "DingTalk Bot",
        enabled: account.enabled,
        configured: !!(account.clientId && account.clientSecret),
        credentialSource: account.credentialSource
      };
    }
  },
  security: {
    resolveDmPolicy({ cfg, accountId, account }) {
      const dm = account.config.dm ?? {};
      return {
        policy: dm.policy ?? "pairing",
        allowFrom: dm.allowFrom ?? []
      };
    }
  },
  outbound: {
    deliveryMode: "buffer",
    textChunkLimit: 2e3,
    async sendText({ to, text, accountId, cfg }) {
      const account = resolveDingTalkAccount({ cfg, accountId });
      const { type, id } = parseOutboundTo(to);
      const longTextMode = account.config?.longTextMode ?? "chunk";
      const longTextThreshold = account.config?.longTextThreshold ?? 4e3;
      if (longTextMode === "file" && text.length > longTextThreshold) {
        console.log(`[dingtalk] Outbound text exceeds threshold (${text.length} > ${longTextThreshold}), sending as file`);
        const { buffer, fileName } = textToMarkdownFile(text, "AI Response");
        const uploadResult = await uploadMediaFile({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          fileBuffer: buffer,
          fileName,
          fileType: "file"
        });
        if (uploadResult.mediaId) {
          const sendResult = await sendFileMessage({
            clientId: account.clientId,
            clientSecret: account.clientSecret,
            robotCode: account.robotCode || account.clientId,
            userId: type === "dm" ? id : void 0,
            conversationId: type === "group" ? id : void 0,
            mediaId: uploadResult.mediaId,
            fileName
          });
          if (sendResult.ok) {
            console.log(`[dingtalk] File sent successfully via outbound: ${fileName}`);
            return { channel: "dingtalk", ok: true };
          }
          console.log(`[dingtalk] File send failed, falling back to text: ${sendResult.error}`);
        } else {
          console.log(`[dingtalk] File upload failed, falling back to text: ${uploadResult.error}`);
        }
      }
      if (type === "dm") {
        await sendDingTalkRestMessage({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          userId: id,
          text
        });
      } else if (type === "group") {
        await sendDingTalkRestMessage({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          conversationId: id,
          text
        });
      }
      return { channel: "dingtalk", ok: true };
    },
    async sendFile({ to, content, fileName, accountId, cfg }) {
      const account = resolveDingTalkAccount({ cfg, accountId });
      const { type, id } = parseOutboundTo(to);
      let fileBuffer;
      if (typeof content === "string") {
        const bom = Buffer.from([239, 187, 191]);
        const textContent = Buffer.from(content, "utf-8");
        fileBuffer = Buffer.concat([bom, textContent]);
      } else if (Buffer.isBuffer(content)) {
        fileBuffer = content;
      } else {
        throw new Error("content must be a string or Buffer");
      }
      const uploadResult = await uploadMediaFile({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        robotCode: account.robotCode || account.clientId,
        fileBuffer,
        fileName: fileName || "file.txt",
        fileType: "file"
      });
      if (!uploadResult.mediaId) {
        throw new Error(`File upload failed: ${uploadResult.error}`);
      }
      const sendResult = await sendFileMessage({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        robotCode: account.robotCode || account.clientId,
        userId: type === "dm" ? id : void 0,
        conversationId: type === "group" ? id : void 0,
        mediaId: uploadResult.mediaId,
        fileName: fileName || "file.txt"
      });
      if (!sendResult.ok) {
        throw new Error(`File send failed: ${sendResult.error}`);
      }
      console.log(`[dingtalk] File sent via outbound.sendFile: ${fileName}`);
      return { channel: "dingtalk", ok: true };
    },
    async sendMedia({ to, text, mediaUrl, accountId, cfg }) {
      if (!mediaUrl) {
        throw new Error("mediaUrl is required for sending media on DingTalk");
      }
      if (!mediaUrl.startsWith("http://") && !mediaUrl.startsWith("https://")) {
        throw new Error("DingTalk requires publicly accessible image URLs (http:// or https://)");
      }
      const account = resolveDingTalkAccount({ cfg, accountId });
      const { type, id } = parseOutboundTo(to);
      const imageMarkdown = `![image](${mediaUrl})`;
      const textMessage = text ? `${text}

${imageMarkdown}` : imageMarkdown;
      if (type === "dm") {
        await sendDingTalkRestMessage({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          userId: id,
          text: textMessage
        });
      } else if (type === "group") {
        await sendDingTalkRestMessage({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          conversationId: id,
          text: textMessage
        });
      }
      return { channel: "dingtalk", ok: true };
    }
  },
  // Handle message actions (sendAttachment, etc.)
  actions: {
    // New SDK interface (2026.3.22+): replaces listActions
    describeMessageTool({ cfg }) {
      return {
        actions: ["send", "sendAttachment"],
        instructions: [
          "DingTalk @mention syntax: wrap staffId in <at:STAFFID> markers.",
          'Example: "<at:0164546066>\u4F60\u597D" sends a real @mention to that user.',
          "The <at:...> marker is stripped from displayed text automatically.",
          'Look up staffId: use "dws contact user search --query NAME --format json".',
          "The message sender is auto-@mentioned in group replies (no marker needed for them).",
          "IMPORTANT: Do NOT write @Name or at:id \u2014 only <at:STAFFID> with angle brackets works."
        ].join(" ")
      };
    },
    // Legacy - kept for compatibility
    listActions({ cfg }) {
      return ["send", "sendAttachment"];
    },
    supportsAction({ action }) {
      return action === "sendAttachment" || action === "send";
    },
    async handleAction(ctx) {
      const { action, params, cfg, accountId, conversationTarget } = ctx;
      if (action === "send") {
        const text = params?.text || params?.message;
        if (!text) return null;
        let target2 = params?.target || params?.to || conversationTarget;
        if (!target2) return null;
        const { type: type2, id: id2 } = parseOutboundTo(target2);
        const cacheKey = (type2 === "dm" ? "dm:" : "group:") + id2;
        const cached = getCachedReplyTarget(cacheKey);
        const account2 = resolveDingTalkAccount({ cfg, accountId });
        const replyTarget = cached ? { ...cached, account: account2 } : {
          sessionWebhook: void 0,
          sessionWebhookExpiry: 0,
          conversationId: type2 === "group" ? id2 : "",
          senderId: type2 === "dm" ? id2 : "",
          isDm: type2 === "dm",
          account: account2
        };
        await deliverReply(replyTarget, text);
        return {
          ok: true,
          channel: "dingtalk",
          content: [{ type: "text", text: JSON.stringify({ ok: true, sent: true }) }]
        };
      }
      if (action !== "sendAttachment") {
        return null;
      }
      const buffer = params?.buffer;
      const filename = params?.filename || "attachment.bin";
      let target = params?.target || params?.to;
      if (!target && conversationTarget) {
        target = conversationTarget;
        console.log(`[dingtalk] sendAttachment: inferred target from context: ${target}`);
      }
      if (!buffer) {
        console.warn("[dingtalk] sendAttachment: missing buffer parameter");
        return { ok: false, error: "Missing buffer parameter. Use base64-encoded file content." };
      }
      if (!target) {
        console.warn("[dingtalk] sendAttachment: missing target/to parameter");
        return {
          ok: false,
          error: 'Missing target parameter. Use "to" or "target" with format: "dm:userId" or "group:conversationId" or just "userId" for DM.'
        };
      }
      const account = resolveDingTalkAccount({ cfg, accountId });
      const { type, id } = parseOutboundTo(target);
      let fileBuffer;
      try {
        fileBuffer = Buffer.from(buffer, "base64");
      } catch {
        return { ok: false, error: "Invalid base64 buffer" };
      }
      const isTextFile = /\.(txt|md|json|csv|xml|html?)$/i.test(filename);
      if (isTextFile) {
        const bom = Buffer.from([239, 187, 191]);
        if (fileBuffer[0] !== 239 || fileBuffer[1] !== 187 || fileBuffer[2] !== 191) {
          fileBuffer = Buffer.concat([bom, fileBuffer]);
        }
      }
      const uploadResult = await uploadMediaFile({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        robotCode: account.robotCode || account.clientId,
        fileBuffer,
        fileName: filename,
        fileType: "file"
      });
      if (!uploadResult.mediaId) {
        console.warn(`[dingtalk] sendAttachment upload failed: ${uploadResult.error}`);
        return { ok: false, error: uploadResult.error };
      }
      const sendResult = await sendFileMessage({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        robotCode: account.robotCode || account.clientId,
        userId: type === "dm" ? id : void 0,
        conversationId: type === "group" ? id : void 0,
        mediaId: uploadResult.mediaId,
        fileName: filename
      });
      if (!sendResult.ok) {
        console.warn(`[dingtalk] sendAttachment send failed: ${sendResult.error}`);
        return { ok: false, error: sendResult.error };
      }
      console.log(`[dingtalk] sendAttachment success: ${filename}`);
      return {
        ok: true,
        channel: "dingtalk",
        filename,
        // SDK expects content array format for tool results
        content: [{ type: "text", text: JSON.stringify({ ok: true, filename }) }]
      };
    }
  },
  gateway: {
    async startAccount({ account, signal, setStatus }) {
      const runtime = getDingTalkRuntime();
      const log = runtime.log?.child?.({ channel: "dingtalk", account: account.accountId }) ?? runtime.log ?? console;
      const cfg = runtime.config;
      log.info?.("[dingtalk] Starting Stream connection...");
      runtime.channel?.activity?.record?.("dingtalk", account.accountId, "start");
      if (signal) {
        signal.addEventListener("abort", () => {
          runtime.channel?.activity?.record?.("dingtalk", account.accountId, "stop");
        }, { once: true });
      }
      try {
        await startDingTalkMonitor({
          account,
          cfg,
          abortSignal: signal,
          log,
          setStatus
        });
        log.info?.("[dingtalk] Stream connection started successfully");
      } catch (err) {
        log.error?.("[dingtalk] Failed to start Stream", err);
        throw err;
      }
    }
  },
  status: {
    async probeAccount(account) {
      if (!account.configured || !account.clientId || !account.clientSecret) {
        return { ok: false, error: "Not configured" };
      }
      return await probeDingTalk(account.clientId, account.clientSecret);
    }
  },
  onboarding: {
    async run(ctx) {
      const { onboardDingTalk: onboardDingTalk2 } = await Promise.resolve().then(() => (init_onboarding(), onboarding_exports));
      return onboardDingTalk2(ctx);
    }
  }
};

// index.ts
var plugin = {
  id: "dingtalk",
  name: "DingTalk",
  description: "DingTalk channel plugin with Stream Mode support",
  configSchema: dingTalkConfigSchema,
  register(api) {
    setDingTalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
  }
};
var index_default = plugin;
export {
  index_default as default
};
