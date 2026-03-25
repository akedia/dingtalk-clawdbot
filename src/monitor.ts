import type { DingTalkRobotMessage, ResolvedDingTalkAccount, ExtractedMessage } from "./types.js";
import { sendViaSessionWebhook, sendMarkdownViaSessionWebhook, sendDingTalkRestMessage, batchGetUserInfo, downloadPicture, downloadMediaFile, cleanupOldMedia, uploadMediaFile, sendFileMessage, textToMarkdownFile, sendTypingIndicator } from "./api.js";
import { getDingTalkRuntime } from "./runtime.js";
import { cacheInboundDownloadCode, getCachedDownloadCode } from "./quoted-msg-cache.js";
import { resolveQuotedFile } from "./quoted-file-service.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Message Deduplication - prevent duplicate processing after Stream reconnect.
// DingTalk re-delivers messages that weren't ACK'd before disconnect using the
// same protocol messageId, so we track recently processed IDs.
// ============================================================================

const DEDUP_MAX_SIZE = 1000;
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

const processedMessageIds = new Map<string, number>(); // messageId → timestamp

function isDuplicateMessage(messageId: string): boolean {
  if (!messageId) return false;
  return processedMessageIds.has(messageId);
}

function markMessageProcessed(messageId: string): void {
  if (!messageId) return;
  processedMessageIds.set(messageId, Date.now());

  // Evict expired entries when cache exceeds max size
  if (processedMessageIds.size > DEDUP_MAX_SIZE) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [id, ts] of processedMessageIds) {
      if (ts < cutoff) processedMessageIds.delete(id);
    }
    // If still over limit after TTL eviction, drop oldest
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

// ============================================================================
// Message Cache - used to resolve quoted message content from originalMsgId
// DingTalk Stream API does NOT include quoted content in reply callbacks;
// it only provides originalMsgId. We cache incoming/outgoing messages to look them up.
// Cache is persisted to disk so it survives gateway restarts.
// ============================================================================

interface CachedMessage {
  senderNick: string;
  text: string;       // human-readable content
  msgtype: string;
  ts: number;         // Date.now() at receive time
}

const MSG_CACHE_MAX = 500;           // max entries to keep
const MSG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const MSG_CACHE_FILE = path.join(os.homedir(), ".openclaw", "extensions", "dingtalk", ".cache", "msg-cache.json");

const msgCache = new Map<string, CachedMessage>();

/** Time-indexed outbound message cache for interactiveCard quote resolution.
 *  Key = send timestamp (ms), value = message text.
 *  When a quote comes in with msgType=interactiveCard (no content), we look up
 *  the closest outbound message by repliedMsg.createdAt within OUTBOUND_TIME_WINDOW_MS.
 */
const outboundByTime: Array<{ ts: number; text: string }> = [];
const OUTBOUND_TIME_CACHE_MAX = 100;
const OUTBOUND_TIME_WINDOW_MS = 10_000; // ±10s tolerance

/** Load persisted cache from disk on startup */
function loadMsgCache(): void {
  try {
    if (fs.existsSync(MSG_CACHE_FILE)) {
      const raw = fs.readFileSync(MSG_CACHE_FILE, "utf-8");
      const entries: [string, CachedMessage][] = JSON.parse(raw);
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

/** Persist cache to disk (debounced write) */
let _saveCacheTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveCache(): void {
  if (_saveCacheTimer) return;
  _saveCacheTimer = setTimeout(() => {
    _saveCacheTimer = null;
    try {
      const dir = path.dirname(MSG_CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const entries = [...msgCache.entries()];
      fs.writeFileSync(MSG_CACHE_FILE, JSON.stringify(entries), "utf-8");
    } catch (err) {
      console.warn(`[dingtalk] Failed to save msg cache: ${err}`);
    }
  }, 2000); // debounce 2s
}

// Load cache on module init
loadMsgCache();

function msgCacheSet(msgId: string, entry: CachedMessage): void {
  // Evict expired entries if cache is full
  if (msgCache.size >= MSG_CACHE_MAX) {
    const cutoff = Date.now() - MSG_CACHE_TTL_MS;
    for (const [k, v] of msgCache) {
      if (v.ts < cutoff) msgCache.delete(k);
    }
    // If still full, evict oldest
    if (msgCache.size >= MSG_CACHE_MAX) {
      const oldest = [...msgCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) msgCache.delete(oldest[0]);
    }
  }
  msgCache.set(msgId, entry);
  scheduleSaveCache();
}

/** Cache an outbound (bot-sent) message so it can be resolved when quoted */
export function cacheOutboundMessage(key: string, text: string): void {
  if (!key || !text) return;
  const now = Date.now();
  msgCacheSet(key, { senderNick: 'Jax', text, msgtype: 'text', ts: now });
  // Also cache by timestamp for interactiveCard quote resolution
  outboundByTime.push({ ts: now, text });
  if (outboundByTime.length > OUTBOUND_TIME_CACHE_MAX) outboundByTime.shift();
}

/** Cache an outbound message by timestamp only (for sessionWebhook sends that return no key) */
export function cacheOutboundMessageByTime(text: string): void {
  if (!text) return;
  outboundByTime.push({ ts: Date.now(), text });
  if (outboundByTime.length > OUTBOUND_TIME_CACHE_MAX) outboundByTime.shift();
}

/** Look up an outbound message by DingTalk createdAt timestamp (for interactiveCard quotes) */
function resolveOutboundByTime(createdAt: number): string | undefined {
  if (!createdAt || outboundByTime.length === 0) return undefined;
  // Find the closest entry within the tolerance window
  let best: { ts: number; text: string } | undefined;
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

// ============================================================================
// Message Aggregation Buffer
// ============================================================================
// When users share links via DingTalk's "share link" feature, the message may
// arrive as multiple separate messages (text + URL). This buffer aggregates
// messages from the same sender within a short time window.

interface BufferedMessage {
  messages: Array<{ text: string; timestamp: number; mediaPath?: string; mediaType?: string }>;
  timer: ReturnType<typeof setTimeout>;
  ctx: DingTalkMonitorContext;
  msg: DingTalkRobotMessage;  // Keep latest msg for reply target
  replyTarget: any;
  sessionKey: string;
  isDm: boolean;
  senderId: string;
  senderName: string;
  conversationId: string;
}

const messageBuffer = new Map<string, BufferedMessage>();
const AGGREGATION_DELAY_MS = 2000; // 2 seconds - balance between UX and catching split messages

// ============================================================================
// Per-Session Message Queue - serializes dispatch to prevent concurrent
// processing of messages in the same conversation. Uses Promise chaining:
// each new message's dispatch waits for the previous one to complete.
// ============================================================================

const sessionQueues = new Map<string, Promise<void>>();
const sessionQueueLastActivity = new Map<string, number>();
const SESSION_QUEUE_TTL_MS = 5 * 60 * 1000; // 5 min

const QUEUE_BUSY_PHRASES = [
  "收到，前面还有消息在处理，稍后按顺序继续。",
  "当前正在处理中，你的新消息已排队，完成后马上继续。",
  "我还在处理上一条，这条已记下，稍后继续。",
];

/** Clean up expired session queues (runs periodically) */
function cleanupExpiredSessionQueues(): void {
  const now = Date.now();
  for (const [key, ts] of sessionQueueLastActivity) {
    if (now - ts > SESSION_QUEUE_TTL_MS && !sessionQueues.has(key)) {
      sessionQueueLastActivity.delete(key);
    }
  }
}

function getBufferKey(msg: DingTalkRobotMessage, accountId: string): string {
  return `${accountId}:${msg.conversationId}:${msg.senderId || msg.senderStaffId}`;
}

// ============================================================================

export interface DingTalkMonitorContext {
  account: ResolvedDingTalkAccount;
  cfg: any;
  abortSignal: AbortSignal;
  log?: any;
  setStatus?: (update: Record<string, unknown>) => void;
}

export async function startDingTalkMonitor(ctx: DingTalkMonitorContext): Promise<void> {
  const { account, cfg, abortSignal, log, setStatus } = ctx;

  if (!account.clientId || !account.clientSecret) {
    throw new Error("DingTalk clientId/clientSecret not configured");
  }

  // Clean up old pictures on startup
  cleanupOldMedia();

  // Schedule periodic cleanup every hour
  const cleanupInterval = setInterval(() => {
    cleanupOldMedia();
  }, 60 * 60 * 1000); // 1 hour

  // Schedule session queue cleanup every 60s
  const queueCleanupInterval = setInterval(cleanupExpiredSessionQueues, 60_000);

  // Clean up on abort (only if abortSignal is provided)
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => {
      clearInterval(cleanupInterval);
      clearInterval(queueCleanupInterval);
      // Only clear this account's queue entries (other accounts may still be running)
      const prefix = account.accountId + ':';
      for (const key of sessionQueues.keys()) {
        if (key.startsWith(prefix)) sessionQueues.delete(key);
      }
      for (const key of sessionQueueLastActivity.keys()) {
        if (key.startsWith(prefix)) sessionQueueLastActivity.delete(key);
      }
    });
  }

  let DWClient: any;
  let TOPIC_ROBOT: any;
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
    keepAlive: false,      // Disabled: SDK's 8s ping/pong terminates on unreachable gateway endpoints
    autoReconnect: false,  // We manage reconnection with exponential backoff
  });

  // Reconnection configuration
  const HEARTBEAT_CHECK_MS = 30_000;     // Check connectivity every 30s
  const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min no activity = force reconnect
  const RECONNECT_BASE_MS = 1_000;       // 1s initial backoff
  const RECONNECT_CAP_MS = 30_000;       // 30s max backoff
  let reconnectAttempt = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastActivityTime = Date.now();

  // Track message activity to extend heartbeat window
  const touchActivity = () => { lastActivityTime = Date.now(); };

  client.registerCallbackListener(TOPIC_ROBOT, async (downstream: any) => {
    const protocolMsgId = downstream.headers?.messageId;

    // Immediately ACK to prevent DingTalk from retrying (60s timeout)
    try {
      client.socketCallBackResponse(protocolMsgId, { status: 'SUCCESS' });
    } catch (_) { /* best-effort ACK */ }

    touchActivity(); // Track message activity for heartbeat

    // Deduplication: skip messages already processed (e.g. re-delivered after reconnect)
    if (isDuplicateMessage(protocolMsgId)) {
      log?.info?.("[dingtalk] Duplicate message skipped: " + protocolMsgId);
      return { status: "SUCCESS", message: "OK" };
    }
    markMessageProcessed(protocolMsgId);

    try {
      const data: DingTalkRobotMessage = typeof downstream.data === "string"
        ? JSON.parse(downstream.data) : downstream.data;
      setStatus?.({ lastInboundAt: Date.now() });
      await processInboundMessage(data, ctx);
    } catch (err) {
      log?.info?.("[dingtalk] Message error: " + err);
    }
    return { status: "SUCCESS", message: "OK" };
  });

  client.registerAllEventListener((msg: any) => {
    return { status: "SUCCESS", message: "OK" };
  });

  // ============================================================================
  // Connection loop with custom heartbeat + exponential backoff reconnection.
  // Keeps this function alive until abort signal fires.
  // If we return, OpenClaw considers the channel "stopped" and enters auto-restart loop.
  // ============================================================================
  while (!abortSignal?.aborted) {
    try {
      await client.connect();
      const connectTime = Date.now();
      lastActivityTime = connectTime;
      log?.info?.("[dingtalk:" + account.accountId + "] Stream connected");
      setStatus?.({ running: true, lastStartAt: connectTime });

      // Start heartbeat monitor: if no activity for 5 minutes, force disconnect to trigger reconnect.
      // The SDK's keepAlive ping/pong (8s interval) handles socket-level liveness and sets
      // client.connected=false on missed pongs, which our poll loop below detects.
      // This heartbeat is a secondary safety net for higher-level silent failures where
      // the socket stays open but DingTalk stops delivering messages.
      heartbeatTimer = setInterval(() => {
        const elapsed = Date.now() - lastActivityTime;
        if (elapsed > HEARTBEAT_TIMEOUT_MS) {
          log?.warn?.("[dingtalk] Heartbeat timeout (" + Math.round(elapsed / 1000) + "s since last activity), forcing reconnect");
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          try { client.disconnect?.(); } catch {}
        }
      }, HEARTBEAT_CHECK_MS);

      // Wait for disconnect or abort
      await new Promise<void>((resolve) => {
        // Poll client.connected (SDK sets false on socket close / system disconnect)
        const pollTimer = setInterval(() => {
          if (!client.connected) { clearInterval(pollTimer); resolve(); }
        }, 1000);
        if (abortSignal) {
          abortSignal.addEventListener("abort", () => {
            clearInterval(pollTimer);
            resolve();
          }, { once: true });
        }
      });

      // Only reset backoff if connection was stable (survived > 30s)
      // This prevents rapid reconnect loops when connect() succeeds but
      // the socket drops immediately (e.g. gateway returns unreachable endpoint)
      if (Date.now() - connectTime > 30_000) {
        reconnectAttempt = 0;
      }
    } catch (err) {
      log?.warn?.("[dingtalk] Connection error: " + (err instanceof Error ? err.message : String(err)));
    }

    // Clean up heartbeat
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

    if (abortSignal?.aborted) break; // Clean shutdown

    setStatus?.({ running: false });

    // Exponential backoff with jitter
    reconnectAttempt++;
    const backoff = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt - 1), RECONNECT_CAP_MS);
    const jitter = Math.random() * backoff * 0.3;
    const delay = Math.round(backoff + jitter);
    log?.info?.("[dingtalk] Reconnect attempt " + reconnectAttempt + " in " + delay + "ms");

    // Sleep with abort-awareness
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      if (abortSignal) {
        abortSignal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      }
    });
  }

  // Final cleanup
  try { client.disconnect?.(); } catch {}
  setStatus?.({ running: false, lastStopAt: Date.now() });
}

/**
 * Extract message content from DingTalk message into a structured format.
 * Handles: text, richText, picture, audio, video, file.
 */
async function extractMessageContent(
  msg: DingTalkRobotMessage,
  account: ResolvedDingTalkAccount,
  log?: any,
): Promise<ExtractedMessage> {
  const msgtype = msg.msgtype || 'text';
  const content = msg.content;

  switch (msgtype) {
    case 'text': {
      return {
        text: msg.text?.content?.trim() ?? '',
        messageType: 'text',
      };
    }

    case 'richText': {
      const result = await extractRichTextContent(msg, account, log);
      return { ...result, messageType: 'richText' };
    }

    case 'picture': {
      return extractPictureContent(msg, log);
    }

    case 'markdown': {
      // DingTalk markdown messages have content in content.text or content.title
      const markdownText = content?.text?.trim() || '';
      const markdownTitle = content?.title?.trim() || '';
      const text = markdownText || markdownTitle || '[Markdown消息]';
      log?.info?.("[dingtalk] Markdown message received (" + text.length + " chars)");
      return {
        text,
        messageType: 'markdown',
      };
    }

    case 'audio': {
      // DingTalk provides speech recognition result in content.recognition
      const recognition = content?.recognition;
      const downloadCode = content?.downloadCode;
      log?.info?.("[dingtalk] Audio message - recognition: " + (recognition || '(none)'));
      return {
        text: recognition || '[语音消息]',
        mediaDownloadCode: downloadCode,
        mediaType: 'audio',
        messageType: 'audio',
      };
    }

    case 'video': {
      const downloadCode = content?.downloadCode;
      log?.info?.("[dingtalk] Video message - downloadCode: " + (downloadCode || '(none)'));
      return {
        text: '[视频]',
        mediaDownloadCode: downloadCode,
        mediaType: 'video',
        messageType: 'video',
      };
    }

    case 'file': {
      const downloadCode = content?.downloadCode;
      const fileName = content?.fileName || '未知文件';
      log?.info?.("[dingtalk] File message - fileName: " + fileName);
      return {
        text: `[文件: ${fileName}]`,
        mediaDownloadCode: downloadCode,
        mediaType: 'file',
        mediaFileName: fileName,
        messageType: 'file',
      };
    }

    case 'link': {
      // Link card message - contains title, text, messageUrl, and optional picUrl
      // Structure: msg.link = { title, text, messageUrl, picUrl }
      const linkContent = msg.link || content;
      log?.info?.("[dingtalk] link message received: " + JSON.stringify(linkContent));

      if (linkContent) {
        const title = linkContent.title || '';
        const text = linkContent.text || '';
        const messageUrl = linkContent.messageUrl || '';
        const picUrl = linkContent.picUrl || '';

        // Combine all parts into a readable format
        const parts: string[] = [];
        if (title) parts.push(`[链接] ${title}`);
        if (text) parts.push(text);
        if (messageUrl) parts.push(`链接: ${messageUrl}`);
        if (picUrl) parts.push(`配图: ${picUrl}`);

        const resultText = parts.join('\n') || '[链接卡片]';
        log?.info?.("[dingtalk] Extracted link message: " + resultText.slice(0, 100));

        return {
          text: resultText,
          messageType: 'link',
        };
      }

      return {
        text: '[链接卡片]',
        messageType: 'link',
      };
    }

    case 'chatRecord': {
      // Chat record collection - contains multiple forwarded messages
      // Structure: content.chatRecord is a JSON string containing an array of messages
      const chatRecordContent = content || (msg as any).chatRecord;
      log?.info?.("[dingtalk] chatRecord message received");

      try {
        // chatRecord is a JSON string, need to parse it
        const chatRecordStr = chatRecordContent?.chatRecord;
        if (chatRecordStr && typeof chatRecordStr === 'string') {
          const records = JSON.parse(chatRecordStr) as Array<{
            senderId?: string;
            senderStaffId?: string;  // Non-encrypted userId (available when app is published)
            senderNick?: string;
            msgType?: string;
            content?: string;
            downloadCode?: string;  // For media messages (picture, video, file)
            createAt?: number;
          }>;

          if (Array.isArray(records) && records.length > 0) {
            // Debug: log first record structure with all keys
            const firstRecord = records[0];
            log?.info?.("[dingtalk] chatRecord first record keys: " + Object.keys(firstRecord).join(', '));
            log?.info?.("[dingtalk] chatRecord first record: " + JSON.stringify(firstRecord));

            // Collect unique userIds for batch lookup
            // Prefer senderStaffId (non-encrypted) over senderId
            const senderIds = [...new Set(
              records
                .map(r => r.senderStaffId || (r.senderId && !r.senderId.startsWith('$:') ? r.senderId : null))
                .filter((id): id is string => !!id)
            )].slice(0, 10); // Limit to 10 users

            log?.info?.("[dingtalk] chatRecord senderIds for lookup: " + JSON.stringify(senderIds));

            // Try to resolve sender names via API
            let senderNameMap = new Map<string, string>();
            if (senderIds.length > 0 && account.clientId && account.clientSecret) {
              try {
                senderNameMap = await batchGetUserInfo(account.clientId, account.clientSecret, senderIds, 3000);
                log?.info?.("[dingtalk] Resolved " + senderNameMap.size + " sender names from API");
              } catch (err) {
                log?.info?.("[dingtalk] Failed to resolve sender names: " + err);
              }
            }

            // Process records with async image downloads
            const formattedRecords = await Promise.all(records.map(async (record, idx) => {
              // Try: senderNick > API resolved name (via staffId or senderId) > fallback
              let sender = record.senderNick;
              if (!sender) {
                // Try to get name from API lookup
                const lookupId = record.senderStaffId || record.senderId;
                if (lookupId) {
                  sender = senderNameMap.get(lookupId);
                }
                // Fallback for encrypted IDs
                if (!sender && record.senderId?.startsWith('$:')) {
                  sender = '成员';
                }
              }
              sender = sender || '未知';

              // Handle different message types in chatRecord
              let msgContent: string;
              switch (record.msgType) {
                case 'text':
                  msgContent = record.content || '[空消息]';
                  break;
                case 'picture':
                case 'image':
                  // Try to download the image
                  if (record.downloadCode && account.clientId && account.clientSecret) {
                    try {
                      const robotCode = account.robotCode || account.clientId;
                      const pictureResult = await downloadPicture(
                        account.clientId, account.clientSecret, robotCode!, record.downloadCode,
                      );
                      if (pictureResult.filePath) {
                        msgContent = `[图片: ${pictureResult.filePath}]`;
                        log?.info?.("[dingtalk] Downloaded chatRecord picture: " + pictureResult.filePath);
                      } else if (pictureResult.error) {
                        msgContent = `[图片下载失败: ${pictureResult.error}]`;
                      } else {
                        msgContent = '[图片]';
                      }
                    } catch (err) {
                      log?.info?.("[dingtalk] Error downloading chatRecord picture: " + err);
                      msgContent = '[图片]';
                    }
                  } else {
                    msgContent = '[图片]';
                  }
                  break;
                case 'video':
                  msgContent = '[视频]';
                  break;
                case 'file':
                  msgContent = '[文件]';
                  break;
                case 'voice':
                case 'audio':
                  msgContent = '[语音]';
                  break;
                case 'richText':
                  msgContent = record.content || '[富文本消息]';
                  break;
                case 'markdown':
                  msgContent = record.content || '[Markdown消息]';
                  break;
                default:
                  msgContent = record.content || `[${record.msgType || '未知'}消息]`;
              }
              const time = record.createAt ? new Date(record.createAt).toLocaleString('zh-CN') : '';
              return `[${idx + 1}] ${sender}${time ? ` (${time})` : ''}: ${msgContent}`;
            }));
            const text = `[聊天记录合集 - ${records.length}条消息]\n${formattedRecords.join('\n')}`;
            log?.info?.("[dingtalk] Parsed chatRecord with " + records.length + " messages");
            return {
              text,
              messageType: 'chatRecord',
            };
          }
        }
      } catch (e) {
        log?.info?.("[dingtalk] Failed to parse chatRecord: " + (e instanceof Error ? e.message : String(e)));
      }

      // Fallback if structure is different or parsing failed
      log?.info?.("[dingtalk] chatRecord structure not recognized, full msg: " + JSON.stringify(msg).slice(0, 500));
      return {
        text: '[聊天记录合集]',
        messageType: 'chatRecord',
      };
    }

    default: {
      // Fallback: try text.content for unknown message types
      const text = msg.text?.content?.trim() || '';
      if (!text) {
        log?.info?.("[dingtalk] Unknown msgtype: " + msgtype + ", no text content found");
        // Log full message structure for debugging unknown types
        log?.info?.("[dingtalk] Unknown msgtype full structure: " + JSON.stringify(msg).slice(0, 1000));
      }
      return {
        text: text || `[${msgtype}消息]`,
        messageType: msgtype,
      };
    }
  }
}

/**
 * Extract content from richText messages.
 * Preserves all existing edge-case handling for DingTalk's varied richText formats.
 */
async function extractRichTextContent(
  msg: DingTalkRobotMessage,
  account: ResolvedDingTalkAccount,
  log?: any,
): Promise<{ text: string; mediaDownloadCode?: string; mediaType?: 'image' }> {
  // First try: msg.text.content (DingTalk sometimes also provides text for richText)
  let text = msg.text?.content?.trim() ?? '';

  // Second try: msg.richText as various formats
  if (!text && msg.richText) {
    try {
      const richTextStr = typeof msg.richText === 'string'
        ? msg.richText
        : JSON.stringify(msg.richText);
      log?.info?.("[dingtalk] Received richText message (full): " + richTextStr);

      const rt = msg.richText as any;

      if (typeof msg.richText === 'string') {
        text = msg.richText.trim();
      } else if (rt) {
        text = rt.text?.trim()
          || rt.content?.trim()
          || rt.richText?.trim()
          || '';

        if (!text && Array.isArray(rt.richText)) {
          const textParts: string[] = [];
          for (const item of rt.richText) {
            if (item.text) {
              textParts.push(item.text);
            } else if (item.content) {
              textParts.push(item.content);
            }
          }
          text = textParts.join('').trim();
        }
      }

      if (text) {
        log?.info?.("[dingtalk] Extracted from richText: " + text.slice(0, 100));
      }
    } catch (err) {
      log?.info?.("[dingtalk] Failed to parse richText: " + err);
    }
  }

  // Third try: msg.content.richText array (when msgtype === 'richText')
  if (!text) {
    const content = msg.content;
    if (content?.richText && Array.isArray(content.richText)) {
      log?.info?.("[dingtalk] RichText message - msg.content: " + JSON.stringify(content).substring(0, 200));
      const parts: string[] = [];

      for (const item of content.richText) {
        if (item.msgType === "text" && item.content) {
          parts.push(item.content);
        } else if (item.text) {
          // DingTalk sometimes sends richText items as {text: "..."} without msgType wrapper
          parts.push(item.text);
        } else if (item.msgType === "quote" || item.type === "quote") {
          // Quoted/referenced message item in richText array (DingTalk v3 quote reply structure)
          const quotedText = item.content?.text
            || (typeof item.content === 'string' ? item.content : null)
            || item.text || '';
          const quotedSender = item.content?.senderNick || item.senderNick || '';
          if (quotedText) {
            const senderPrefix = quotedSender ? `${quotedSender}: ` : '';
            parts.push(`[引用: "${senderPrefix}${String(quotedText).trim().substring(0, 120)}"]`);
            log?.info?.("[dingtalk] Extracted quote item from richText array: " + String(quotedText).substring(0, 60));
          } else {
            log?.info?.("[dingtalk] Quote item in richText but no text content: " + JSON.stringify(item).substring(0, 200));
          }
        } else if ((item.msgType === "picture" || item.pictureDownloadCode || item.downloadCode) && (item.downloadCode || item.pictureDownloadCode)) {
          const downloadCode = item.downloadCode || item.pictureDownloadCode;
          try {
            const robotCode = account.robotCode || account.clientId;
            const pictureResult = await downloadPicture(
              account.clientId!, account.clientSecret!, robotCode!, downloadCode,
            );
            if (pictureResult.filePath) {
              parts.push(`[图片: ${pictureResult.filePath}]`);
              log?.info?.("[dingtalk] Downloaded picture from richText: " + pictureResult.filePath);
            } else if (pictureResult.error) {
              parts.push(`[图片下载失败: ${pictureResult.error}]`);
            } else {
              parts.push("[图片]");
            }
          } catch (err) {
            parts.push(`[图片下载出错: ${err}]`);
            log?.warn?.("[dingtalk] Error downloading picture from richText: " + err);
          }
        }
      }

      text = parts.join('');
      if (text) {
        log?.info?.("[dingtalk] Extracted from msg.content.richText: " + text.substring(0, 100));
      }
    }
  }

  return { text };
}

/**
 * Extract content from picture messages, returning the download code for media pipeline.
 */
function extractPictureContent(msg: DingTalkRobotMessage, log?: any): ExtractedMessage {
  log?.info?.("[dingtalk] Picture message - msg.picture: " + JSON.stringify(msg.picture));
  log?.info?.("[dingtalk] Picture message - msg.content: " + JSON.stringify(msg.content));

  const content = msg.content;
  let downloadCode: string | undefined;

  if (msg.picture?.downloadCode) {
    downloadCode = msg.picture.downloadCode;
  } else if (content?.downloadCode) {
    downloadCode = content.downloadCode;
  }

  if (downloadCode) {
    log?.info?.("[dingtalk] Picture detected, downloadCode: " + downloadCode);
    return {
      text: '[用户发送了图片]',
      mediaDownloadCode: downloadCode,
      mediaType: 'image',
      messageType: 'picture',
    };
  }

  log?.info?.("[dingtalk] Picture msgtype but no downloadCode found");
  return {
    text: '[用户发送了图片(无法获取下载码)]',
    messageType: 'picture',
  };
}

async function processInboundMessage(
  msg: DingTalkRobotMessage,
  ctx: DingTalkMonitorContext,
): Promise<void> {
  const { account, cfg, log, setStatus } = ctx;
  const runtime = getDingTalkRuntime();

  const isDm = msg.conversationType === "1";
  const isGroup = msg.conversationType === "2";

  // Debug: log full message structure for all inbound messages
  // Especially important for catching unknown/quote reply structures
  {
    const hasQuoteIndicators = (msg.text as any)?.isReplyMsg
      || !!(msg as any).quoteMsg
      || !!(msg as any).content?.quote
      || msg.msgtype === 'richText';
    if (msg.msgtype === 'richText' || msg.picture || (msg.atUsers && msg.atUsers.length > 0) || hasQuoteIndicators) {
      log?.info?.("[dingtalk-debug] Full message structure:");
      log?.info?.("[dingtalk-debug]   msgtype: " + msg.msgtype);
      log?.info?.("[dingtalk-debug]   text: " + JSON.stringify(msg.text));
      log?.info?.("[dingtalk-debug]   richText: " + JSON.stringify(msg.richText));
      log?.info?.("[dingtalk-debug]   picture: " + JSON.stringify(msg.picture));
      log?.info?.("[dingtalk-debug]   atUsers: " + JSON.stringify(msg.atUsers));
      log?.info?.("[dingtalk-debug]   RAW MESSAGE: " + JSON.stringify(msg).substring(0, 800));
    } else {
      // For regular text messages, still log a condensed version to catch unexpected fields
      const msgKeys = Object.keys(msg as any).filter(k => !['conversationId','chatbotCorpId','chatbotUserId','msgId','senderNick','isAdmin','senderStaffId','sessionWebhookExpiredTime','createAt','senderCorpId','conversationType','senderId','sessionWebhook','robotCode'].includes(k));
      log?.info?.("[dingtalk-debug] text msg extra fields: " + JSON.stringify(msgKeys) + " | " + JSON.stringify(msg).substring(0, 400));
    }
  }

  // Extract message content using structured extractor
  const extracted = await extractMessageContent(msg, account, log);

  // Download media if present (picture/video/file — but skip audio when ASR text exists)
  let mediaPath: string | undefined;
  let mediaType: string | undefined;

  // For audio messages with successful ASR recognition, use the text directly
  // and skip downloading the .amr file (which would confuse the agent into
  // trying Whisper instead of reading the already-transcribed text).
  const skipMediaDownload = extracted.messageType === 'audio' && !!extracted.text;

  if (!skipMediaDownload && extracted.mediaDownloadCode && account.clientId && account.clientSecret) {
    const robotCode = account.robotCode || account.clientId;
    try {
      const result = await downloadMediaFile(
        account.clientId,
        account.clientSecret,
        robotCode,
        extracted.mediaDownloadCode,
        extracted.mediaType,
        extracted.mediaFileName,   // preserve original filename for PDFs/Excel/etc
      );
      if (result.filePath) {
        mediaPath = result.filePath;
        mediaType = result.mimeType || extracted.mediaType;
        log?.info?.(`[dingtalk] Downloaded ${extracted.mediaType || 'media'}: ${result.filePath}`);
      } else if (result.error) {
        log?.warn?.(`[dingtalk] Media download failed: ${result.error}`);
      }
    } catch (err) {
      log?.warn?.(`[dingtalk] Media download error: ${err}`);
    }
  } else if (skipMediaDownload) {
    log?.info?.("[dingtalk] Audio ASR text available, skipping .amr download");
  }

  // Cache inbound file/video/audio downloadCode for quoted-message fallback
  if (extracted.mediaDownloadCode && msg.msgId && msg.conversationId &&
      (extracted.messageType === 'file' || extracted.messageType === 'video' || extracted.messageType === 'audio')) {
    cacheInboundDownloadCode(
      account.accountId, msg.conversationId, msg.msgId,
      extracted.mediaDownloadCode, extracted.messageType, msg.createAt,
    );
  }

  let rawBody = extracted.text;

  // Check if this might be a quote-only @mention (user quoted a message and @bot with no extra text)
  // DingTalk strips @mention from text, leaving rawBody empty. We must NOT early-return here
  // because the quote resolution below will populate rawBody from the cache.
  const _hasOriginalMsgId = !!(msg as any).originalMsgId || !!(msg as any).originalProcessQueryKey;
  const _hasTopLevelQuote = !!(msg as any).quoteMsg || !!(msg as any).content?.quote || !!(msg as any).content?.referenceMessage;
  const _isLikelyQuoteReply = ((msg.text as any)?.isReplyMsg) || _hasTopLevelQuote || _hasOriginalMsgId;

  if (!rawBody && !mediaPath && !_isLikelyQuoteReply) {
    log?.info?.("[dingtalk] Empty message body after all attempts, skipping. msgtype=" + msg.msgtype);
    return;
  }

  // If rawBody is still empty after quote resolution (e.g. cache miss and no inline quote),
  // and there's no media, drop the message.
  if (!rawBody?.trim() && !mediaPath) {
    log?.info?.("[dingtalk] Empty message body after quote resolution, skipping.");
    return;
  }

  // If media present but rawBody still empty, provide placeholder
  if (!rawBody && mediaPath) {
    const fileLabel = extracted.mediaFileName ? `${extracted.mediaFileName} → ${mediaPath}` : mediaPath;
    rawBody = `[${extracted.messageType}] 媒体文件已下载: ${fileLabel}`;
  }

  // Cache this message so quote replies can look it up later via originalMsgId
  if (msg.msgId && rawBody) {
    msgCacheSet(msg.msgId, {
      senderNick: msg.senderNick || '',
      text: rawBody,
      msgtype: msg.msgtype,
      ts: Date.now(),
    });
  }

  // Handle quoted/replied messages: extract the quoted content and prepend it
  // DingTalk uses at least three structures across API versions:
  //   v1 (older): msg.text.isReplyMsg=true + msg.text.repliedMsg
  //   v2 (stream newer): top-level msg.quoteMsg field
  //   v3 (richText): richText array with msgType="quote" items (handled in extractRichTextContent)
  //   v4 (content.quote): msg.content.quote or msg.content.referenceMessage
  //   v5 (cache lookup): msg.text.isReplyMsg=true + msg.originalMsgId → local cache lookup
  const topLevelQuoteMsg = (msg as any).quoteMsg;
  const contentQuote = (msg as any).content?.quote || (msg as any).content?.referenceMessage;
  const isQuoteReply = (msg.text && (msg.text as any).isReplyMsg) || !!topLevelQuoteMsg || !!contentQuote;

  if (isQuoteReply) {
    log?.info?.("[dingtalk] Quote reply detected. isReplyMsg=" + !!(msg.text as any)?.isReplyMsg + " | has quoteMsg=" + !!topLevelQuoteMsg + " | has contentQuote=" + !!contentQuote);
    log?.info?.("[dingtalk] Full message for quote debug: " + JSON.stringify(msg).substring(0, 1500));

    const repliedMsgSource = (msg.text as any)?.repliedMsg || topLevelQuoteMsg || contentQuote;

    // v5: cache lookup via originalMsgId (DingTalk Stream only provides originalMsgId, not content)
    const originalMsgId = (msg as any).originalMsgId as string | undefined;
    // v6: cache lookup via originalProcessQueryKey (for bot-sent outbound messages)
    const originalProcessQueryKey = (msg as any).originalProcessQueryKey as string | undefined;
    const cachedQuoted = (originalMsgId ? msgCache.get(originalMsgId) : undefined)
      || (originalProcessQueryKey ? msgCache.get(originalProcessQueryKey) : undefined);

    if (cachedQuoted) {
      const resolvedBy = (originalMsgId && msgCache.has(originalMsgId)) ? `msgId=${originalMsgId}` : `pqk=${originalProcessQueryKey}`;
      log?.info?.("[dingtalk] Quote reply resolved from cache (" + resolvedBy + ") sender=" + cachedQuoted.senderNick);
      const senderTag = cachedQuoted.senderNick ? ` (${cachedQuoted.senderNick})` : '';
      rawBody = `[引用回复${senderTag}: "${cachedQuoted.text.trim().substring(0, 200)}"]\n${rawBody}`;
    } else if (repliedMsgSource) {
      try {
        const repliedMsg = repliedMsgSource;
        let quotedContent = "";

        // Extract quoted message content
        if (repliedMsg.content?.richText && Array.isArray(repliedMsg.content.richText)) {
          // richText format: array of {msgType, content} or {msgType, downloadCode}
          const parts: string[] = [];

          for (const item of repliedMsg.content.richText) {
            if (item.msgType === "text" && item.content) {
              parts.push(item.content);
            } else if (item.msgType === "picture" && item.downloadCode) {
              // Download the picture from quoted message
              try {
                const robotCode = account.robotCode || account.clientId;
                const pictureResult = await downloadPicture(
                  account.clientId,
                  account.clientSecret,
                  robotCode,
                  item.downloadCode,
                );

                if (pictureResult.filePath) {
                  parts.push(`[图片: ${pictureResult.filePath}]`);
                  log?.info?.("[dingtalk] Downloaded picture from quoted message: " + pictureResult.filePath);
                } else if (pictureResult.error) {
                  parts.push(`[图片下载失败: ${pictureResult.error}]`);
                } else {
                  parts.push("[图片]");
                }
              } catch (err) {
                parts.push(`[图片下载出错: ${err}]`);
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
          // Some DingTalk versions put quoted text directly in .text
          quotedContent = repliedMsg.text;
        } else if (repliedMsg.text?.content) {
          // Or nested under .text.content
          quotedContent = repliedMsg.text.content;
        } else if (repliedMsg.body) {
          // Yet another possible format
          quotedContent = typeof repliedMsg.body === "string" ? repliedMsg.body : JSON.stringify(repliedMsg.body);
        } else if (typeof repliedMsg === "string") {
          // repliedMsgSource itself might be a plain string
          quotedContent = repliedMsg;
        }

        // Extract sender info if available
        const quoteSender = repliedMsg.senderNick || repliedMsg.senderName || repliedMsg.content?.senderNick || '';

        if (quotedContent) {
          const senderTag = quoteSender ? ` (${quoteSender})` : '';
          rawBody = `[引用回复${senderTag}: "${quotedContent.trim()}"]\n${rawBody}`;
          log?.info?.("[dingtalk] Added quoted message: " + quotedContent.slice(0, 50));
        } else if (repliedMsg.msgType === 'interactiveCard' && repliedMsg.createdAt) {
          // interactiveCard: DingTalk doesn't include content in quote payload.
          // Try timestamp-based lookup against our outbound message cache.
          const timeResolved = resolveOutboundByTime(repliedMsg.createdAt);
          if (timeResolved) {
            rawBody = `[引用回复 (Jax): "${timeResolved.trim().substring(0, 200)}"]\n${rawBody}`;
            log?.info?.("[dingtalk] Resolved interactiveCard quote via timestamp (createdAt=" + repliedMsg.createdAt + "): " + timeResolved.slice(0, 50));
          } else {
            log?.warn?.("[dingtalk] interactiveCard quote: no timestamp match in outbound cache (createdAt=" + repliedMsg.createdAt + ", cache size=" + outboundByTime.length + ")");
          }
        } else if (['file', 'video', 'audio', 'unknownMsgType'].includes(repliedMsg.msgType)) {
          // Quoted file/video/audio message — bot may not have seen the original.
          // 'unknownMsgType' is returned by DingTalk for files sent via drag-and-drop
          // (without @bot), so the bot never indexed the original message type.
          // Fallback chain: inline downloadCode → cache → group file API
          log?.info?.("[dingtalk] Quoted file-type message (msgType=" + repliedMsg.msgType + "), attempting fallback resolution");
          const quoteSender = repliedMsg.senderNick || repliedMsg.senderName || '';
          const quoteMsgId = repliedMsg.msgId;
          let resolvedFile = false;

          // 1. Try inline downloadCode (rare — usually absent when bot didn't see the original)
          const inlineDownloadCode = repliedMsg.content?.downloadCode || repliedMsg.downloadCode;
          if (inlineDownloadCode && account.clientId && account.clientSecret) {
            try {
              const robotCode = account.robotCode || account.clientId;
              const dlResult = await downloadMediaFile(
                account.clientId, account.clientSecret, robotCode,
                inlineDownloadCode, repliedMsg.msgType,
                repliedMsg.content?.fileName,
              );
              if (dlResult.filePath) {
                if (!mediaPath) {
                  mediaPath = dlResult.filePath;
                  mediaType = dlResult.mimeType || repliedMsg.msgType;
                }
                const senderTag = quoteSender ? ` (${quoteSender})` : '';
                rawBody = `[引用文件${senderTag}: ${dlResult.filePath}]\n${rawBody}`;
                resolvedFile = true;
                log?.info?.("[dingtalk] Quoted file resolved via inline downloadCode: " + dlResult.filePath);
              }
            } catch (err) {
              log?.warn?.("[dingtalk] Quoted file inline download failed: " + err);
            }
          }

          // 2. Try quoted-msg-cache
          if (!resolvedFile && quoteMsgId && account.clientId && account.clientSecret) {
            const cached = getCachedDownloadCode(account.accountId, msg.conversationId, quoteMsgId);
            if (cached?.downloadCode) {
              try {
                const robotCode = account.robotCode || account.clientId;
                const dlResult = await downloadMediaFile(
                  account.clientId, account.clientSecret, robotCode,
                  cached.downloadCode, cached.msgType as any,
                );
                if (dlResult.filePath) {
                  if (!mediaPath) {
                    mediaPath = dlResult.filePath;
                    mediaType = dlResult.mimeType || cached.msgType;
                  }
                  const senderTag = quoteSender ? ` (${quoteSender})` : '';
                  rawBody = `[引用文件${senderTag}: ${dlResult.filePath}]\n${rawBody}`;
                  resolvedFile = true;
                  log?.info?.("[dingtalk] Quoted file resolved via cache (downloadCode): " + dlResult.filePath);
                }
              } catch (err) {
                log?.warn?.("[dingtalk] Quoted file cache download failed: " + err);
              }
            }
          }

          // 3. Try group file API fallback
          if (!resolvedFile && account.clientId && account.clientSecret) {
            try {
              const fileResult = await resolveQuotedFile(
                { clientId: account.clientId, clientSecret: account.clientSecret },
                {
                  openConversationId: msg.conversationId,
                  // repliedMsg often lacks senderStaffId (DingTalk only provides encrypted senderId).
                  // Fall back to the outer message sender's staffId — any group member works for space query.
                  senderStaffId: repliedMsg.senderStaffId || msg.senderStaffId,
                  fileCreatedAt: repliedMsg.createdAt || repliedMsg.createAt,
                },
                log,
              );
              if (fileResult) {
                if (!mediaPath) {
                  mediaPath = fileResult.media.path;
                  mediaType = fileResult.media.mimeType;
                }
                const senderTag = quoteSender ? ` (${quoteSender})` : '';
                const nameLabel = fileResult.name ? ` ${fileResult.name}` : '';
                rawBody = `[引用文件${senderTag}:${nameLabel} ${fileResult.media.path}]\n${rawBody}`;
                resolvedFile = true;
                // Write back to cache for future lookups
                if (quoteMsgId) {
                  cacheInboundDownloadCode(
                    account.accountId, msg.conversationId, quoteMsgId,
                    undefined, repliedMsg.msgType, repliedMsg.createdAt || repliedMsg.createAt || Date.now(),
                    { spaceId: fileResult.spaceId, fileId: fileResult.fileId },
                  );
                }
                log?.info?.("[dingtalk] Quoted file resolved via group file API: " + fileResult.media.path);
              }
            } catch (err) {
              log?.warn?.("[dingtalk] Quoted file group API fallback failed: " + err);
            }
          }

          if (!resolvedFile) {
            const senderTag = quoteSender ? ` (${quoteSender})` : '';
            rawBody = `[引用文件${senderTag}，无法获取内容]\n${rawBody}`;
            log?.warn?.("[dingtalk] Quoted file could not be resolved, all fallbacks exhausted. msgType=" + repliedMsg.msgType + " msgId=" + (quoteMsgId || 'unknown'));
          }
        } else {
          log?.warn?.("[dingtalk] Reply message found but no content extracted, repliedMsg keys: " + Object.keys(repliedMsg || {}).join(',') + " | full: " + JSON.stringify(repliedMsg).substring(0, 500));
        }
      } catch (err) {
        log?.info?.("[dingtalk] Failed to extract quoted message: " + err);
      }
    } else {
      log?.info?.("[dingtalk] Quote reply: no inline content and originalMsgId=" + (originalMsgId || 'none') + " not in cache (cache size=" + msgCache.size + "). Full msg: " + JSON.stringify(msg).substring(0, 800));
    }
  }

  // Handle @mentions: DingTalk removes @username from text.content
  // Query user info for mentioned users (those with staffId)
  if (msg.atUsers && msg.atUsers.length > 0) {
    log?.info?.("[dingtalk] Message has @mentions: " + JSON.stringify(msg.atUsers));

    // Filter users with staffId (exclude bots which don't have staffId)
    const userIds = msg.atUsers
      .filter(u => u.staffId)
      .map(u => u.staffId as string)
      .slice(0, 5); // Limit to 5 users to avoid too many API calls

    if (userIds.length > 0 && account.clientId && account.clientSecret) {
      try {
        // Batch query user info (3s timeout — needs token fetch + API call)
        const userInfoMap = await batchGetUserInfo(account.clientId, account.clientSecret, userIds, 3000);

        if (userInfoMap.size > 0) {
          // Build mention list: [@张三 @李四]
          const mentions = Array.from(userInfoMap.values()).map(name => `@${name}`).join(" ");
          rawBody = `[${mentions}] ${rawBody}`;
          log?.info?.("[dingtalk] Added user mentions: " + mentions);
        } else {
          // Fallback if no user info retrieved
          rawBody = `[有${msg.atUsers.length}人被@] ${rawBody}`;
          log?.info?.("[dingtalk] User info fetch failed, using count fallback");
        }
      } catch (err) {
        // Fallback on error
        rawBody = `[有${msg.atUsers.length}人被@] ${rawBody}`;
        log?.info?.("[dingtalk] Error fetching user info: " + err + ", using count fallback");
      }
    } else {
      // No staffId or credentials - use count fallback
      rawBody = `[有${msg.atUsers.length}人被@] ${rawBody}`;
      log?.info?.("[dingtalk] No staffId or credentials, using count fallback");
    }
  }

  const senderId = msg.senderStaffId || msg.senderId;
  const senderName = msg.senderNick || "";
  const conversationId = msg.conversationId;

  log?.info?.("[dingtalk] " + (isDm ? "DM" : "Group") + " from " + senderName + ": " + rawBody.slice(0, 50));

  // DM access control
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
            "Access denied. Your staffId: " + senderId + "\nAsk admin to add you.",
          ).catch(() => {});
        }
        return;
      }
    }
  }

  // Group access control
  if (isGroup) {
    const groupPolicy = account.config.groupPolicy ?? "allowlist";
    if (groupPolicy === "disabled") return;

    // Check group whitelist
    if (groupPolicy === "allowlist") {
      const groupAllowlist = (account.config.groupAllowlist ?? []).map(String);
      if (groupAllowlist.length > 0 && !isGroupAllowed(conversationId, groupAllowlist)) {
        log?.info?.("[dingtalk] Group not in allowlist: " + conversationId);
        return;
      }
    }

    // Check @mention requirement
    const requireMention = account.config.requireMention !== false;
    if (requireMention && !msg.isInAtList) return;
  }

  const sessionKey = "dingtalk:" + account.accountId + ":" + (isDm ? "dm" : "group") + ":" + conversationId;

  const replyTarget = {
    sessionWebhook: msg.sessionWebhook,
    sessionWebhookExpiry: msg.sessionWebhookExpiredTime,
    conversationId,
    senderId,
    isDm,
    account,
  };

  // Check if message aggregation is enabled
  const aggregationEnabled = account.config.messageAggregation !== false;
  const aggregationDelayMs = account.config.messageAggregationDelayMs ?? AGGREGATION_DELAY_MS;

  if (aggregationEnabled) {
    // Buffer this message for aggregation
    await bufferMessageForAggregation({
      msg, ctx, rawBody, replyTarget, sessionKey, isDm, senderId, senderName, conversationId,
      mediaPath, mediaType,
    });
    return; // Actual dispatch happens when timer fires
  }

  // No aggregation - dispatch immediately
  await dispatchMessage({
    ctx, msg, rawBody, replyTarget, sessionKey, isDm, senderId, senderName, conversationId,
    mediaPath, mediaType,
  });
}

/**
 * Buffer a message for aggregation with other messages from the same sender.
 */
async function bufferMessageForAggregation(params: {
  msg: DingTalkRobotMessage;
  ctx: DingTalkMonitorContext;
  rawBody: string;
  replyTarget: any;
  sessionKey: string;
  isDm: boolean;
  senderId: string;
  senderName: string;
  conversationId: string;
  mediaPath?: string;
  mediaType?: string;
}): Promise<void> {
  const { msg, ctx, rawBody, replyTarget, sessionKey, isDm, senderId, senderName, conversationId, mediaPath, mediaType } = params;
  const { account, log } = ctx;
  const bufferKey = getBufferKey(msg, account.accountId);
  const aggregationDelayMs = account.config.messageAggregationDelayMs ?? AGGREGATION_DELAY_MS;

  const existing = messageBuffer.get(bufferKey);

  if (existing) {
    // Add to existing buffer
    existing.messages.push({ text: rawBody, timestamp: Date.now(), mediaPath, mediaType });
    // Update to latest msg for reply target (use latest sessionWebhook)
    existing.msg = msg;
    existing.replyTarget = replyTarget;

    // Reset timer
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      flushMessageBuffer(bufferKey);
    }, aggregationDelayMs);

    log?.info?.(`[dingtalk] Message buffered, total: ${existing.messages.length} messages`);
  } else {
    // Create new buffer entry
    const newEntry: BufferedMessage = {
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
      conversationId,
    };
    messageBuffer.set(bufferKey, newEntry);

    log?.info?.(`[dingtalk] Message buffered (new), waiting ${aggregationDelayMs}ms for more...`);
  }
}

/**
 * Flush the message buffer and dispatch the combined message.
 */
async function flushMessageBuffer(bufferKey: string): Promise<void> {
  const entry = messageBuffer.get(bufferKey);
  if (!entry) return;

  messageBuffer.delete(bufferKey);

  const { messages, ctx, msg, replyTarget, sessionKey, isDm, senderId, senderName, conversationId } = entry;
  const { log } = ctx;

  // Combine all messages
  const combinedText = messages.map(m => m.text).join('\n');
  // Use the last media if any
  const lastWithMedia = [...messages].reverse().find(m => m.mediaPath);
  const mediaPath = lastWithMedia?.mediaPath;
  const mediaType = lastWithMedia?.mediaType;

  log?.info?.(`[dingtalk] Flushing buffer: ${messages.length} message(s) combined into ${combinedText.length} chars`);

  // Dispatch the combined message
  await dispatchMessage({
    ctx, msg, rawBody: combinedText, replyTarget, sessionKey, isDm, senderId, senderName, conversationId,
    mediaPath, mediaType,
  });
}

/**
 * Dispatch a message to the agent (after aggregation or immediately).
 * Enqueues into per-session queue to prevent concurrent processing.
 */
async function dispatchMessage(params: {
  ctx: DingTalkMonitorContext;
  msg: DingTalkRobotMessage;
  rawBody: string;
  replyTarget: any;
  sessionKey: string;
  isDm: boolean;
  senderId: string;
  senderName: string;
  conversationId: string;
  mediaPath?: string;
  mediaType?: string;
}): Promise<void> {
  const { ctx, conversationId } = params;
  const { account, log } = ctx;

  const queueKey = `${account.accountId}:${conversationId}`;
  const isQueueBusy = sessionQueues.has(queueKey);

  // If queue is busy, send a recallable notification so it disappears when processing starts
  let queueAckCleanup: (() => Promise<void>) | null = null;
  if (isQueueBusy) {
    const phrase = QUEUE_BUSY_PHRASES[Math.floor(Math.random() * QUEUE_BUSY_PHRASES.length)];
    log?.info?.("[dingtalk] Queue busy for " + queueKey + ", notifying user");
    try {
      if (account.clientId && account.clientSecret) {
        const robotCode = account.robotCode || account.clientId;
        const result = await sendTypingIndicator({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode,
          userId: params.isDm ? params.senderId : undefined,
          conversationId: !params.isDm ? conversationId : undefined,
          message: '⏳ ' + phrase,
        });
        if (!result.error) {
          queueAckCleanup = result.cleanup;
        }
      }
    } catch (_) { /* best-effort notification */ }
  }

  // Enqueue: chain onto previous task
  const previousTask = sessionQueues.get(queueKey) || Promise.resolve();
  const currentTask = previousTask
    .then(async () => {
      // Recall queue-busy notification before starting actual processing
      if (queueAckCleanup) {
        try { await queueAckCleanup(); log?.info?.("[dingtalk] Queue ack recalled, starting processing"); } catch (_) {}
      }
      await dispatchMessageInternal(params);
    })
    .catch((err) => {
      log?.info?.("[dingtalk] Queued dispatch error: " + (err instanceof Error ? err.message : String(err)));
    })
    .finally(() => {
      sessionQueueLastActivity.set(queueKey, Date.now());
      // Clean up only if this is still the latest task
      if (sessionQueues.get(queueKey) === currentTask) {
        sessionQueues.delete(queueKey);
      }
    });

  sessionQueues.set(queueKey, currentTask);
  sessionQueueLastActivity.set(queueKey, Date.now());

  // Don't await — fire-and-forget so message buffering and SDK callback stay responsive
}

/**
 * Internal dispatch: actually processes the message (typing indicator, agent call, reply).
 */
async function dispatchMessageInternal(params: {
  ctx: DingTalkMonitorContext;
  msg: DingTalkRobotMessage;
  rawBody: string;
  replyTarget: any;
  sessionKey: string;
  isDm: boolean;
  senderId: string;
  senderName: string;
  conversationId: string;
  mediaPath?: string;
  mediaType?: string;
}): Promise<void> {
  const { ctx, msg, rawBody, replyTarget, sessionKey, isDm, senderId, senderName, conversationId, mediaPath, mediaType } = params;
  const { account, cfg, log, setStatus } = ctx;
  const runtime = getDingTalkRuntime();
  const isGroup = !isDm;

  // Typing indicator cleanup function (will be called after dispatch completes)
  let typingCleanup: (() => Promise<void>) | null = null;

  // Send typing indicator (recallable) if enabled
  // This replaces the old showThinking feature with a better UX - the indicator disappears when reply arrives
  if (account.config.typingIndicator !== false && account.clientId && account.clientSecret) {
    try {
      const typingMessage = account.config.typingIndicatorMessage || '⏳ 思考中...';
      const robotCode = account.robotCode || account.clientId;
      
      const result = await sendTypingIndicator({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        robotCode,
        userId: isDm ? senderId : undefined,
        conversationId: !isDm ? conversationId : undefined,
        message: typingMessage,
      });
      
      if (result.error) {
        log?.info?.('[dingtalk] Typing indicator failed: ' + result.error);
      } else {
        typingCleanup = result.cleanup;
        log?.info?.('[dingtalk] Typing indicator sent (will be recalled on reply)');
      }
    } catch (err) {
      log?.info?.('[dingtalk] Typing indicator error: ' + err);
    }
  }
  // Legacy: Send thinking feedback (opt-in, non-recallable) - only if typingIndicator is explicitly disabled
  else if (account.config.showThinking && replyTarget.sessionWebhook) {
    try {
      await sendViaSessionWebhook(replyTarget.sessionWebhook, '正在思考...');
      log?.info?.('[dingtalk] Sent thinking indicator (legacy, non-recallable)');
    } catch (_) {
      // fire-and-forget, don't block processing
    }
  }

  // Load actual config if cfg is a config manager
  let actualCfg = cfg;
  if (cfg && typeof cfg.loadConfig === "function") {
    try {
      actualCfg = await cfg.loadConfig();
    } catch (err) {
      log?.info?.("[dingtalk] Failed to load config: " + err);
    }
  }

  // Check if the full Clawdbot Plugin SDK pipeline is available
  const hasFullPipeline = !!(
    runtime?.channel?.routing?.resolveAgentRoute &&
    runtime?.channel?.reply?.finalizeInboundContext &&
    runtime?.channel?.reply?.createReplyDispatcherWithTyping &&
    runtime?.channel?.reply?.dispatchReplyFromConfig
  );

  // Track if we've already cleaned up the typing indicator
  let typingCleaned = false;
  const cleanupTyping = async () => {
    if (typingCleanup && !typingCleaned) {
      typingCleaned = true;
      try {
        await typingCleanup();
        log?.info?.('[dingtalk] Typing indicator recalled');
      } catch (err) {
        log?.info?.('[dingtalk] Failed to recall typing indicator: ' + err);
      }
    }
  };

  try {
    if (hasFullPipeline) {
      // Full SDK pipeline: route → session → envelope → dispatch
      await dispatchWithFullPipeline({
        runtime, msg, rawBody, account, cfg: actualCfg, sessionKey, isDm,
        senderId, senderName, conversationId, replyTarget,
        mediaPath, mediaType, log, setStatus,
        onFirstReply: cleanupTyping,
      });
    } else if (runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
      // Fallback: existing buffered block dispatcher
      // Per-group system prompt for fallback path
      const _fallbackGroupsConfig = account?.config?.groups ?? {};
      const _fallbackGroupSystemPrompt = isGroup ? (_fallbackGroupsConfig?.[conversationId]?.systemPrompt?.trim() || undefined) : undefined;

      const ctxPayload = {
        Body: rawBody,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: "dingtalk:" + senderId,
        To: isDm ? ("dingtalk:" + account.accountId + ":dm:" + senderId) : ("dingtalk:" + account.accountId + ":group:" + conversationId),
        SessionKey: sessionKey,
        AccountId: account.accountId,
        ChatType: isDm ? "direct" : "group",
        ConversationLabel: isDm ? senderName : (msg.conversationTitle ?? conversationId),
        SenderName: senderName || undefined,
        SenderId: senderId,
        WasMentioned: isGroup ? msg.isInAtList : undefined,
        Provider: "dingtalk",
        Surface: "dingtalk",
        MessageSid: msg.msgId,
        OriginatingChannel: "dingtalk",
        OriginatingTo: "dingtalk:" + conversationId,
        MediaPath: mediaPath,
        MediaType: mediaType,
        MediaUrl: mediaPath,
        GroupSystemPrompt: _fallbackGroupSystemPrompt,
      };

      // Await dispatch so per-session queue waits for reply delivery to complete
      // before starting the next queued message.
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: actualCfg,
        dispatcherOptions: {
          deliver: async (payload: any) => {
            // Recall typing indicator on first delivery
            await cleanupTyping();

            log?.info?.("[dingtalk] Deliver payload keys: " + Object.keys(payload || {}).join(',') + " text?=" + (typeof payload?.text) + " markdown?=" + (typeof payload?.markdown));
            const textToSend = resolveDeliverText(payload, log);
            if (textToSend) {
              await deliverReply(replyTarget, textToSend, log);
              setStatus?.({ lastOutboundAt: Date.now() });
            } else {
              log?.info?.("[dingtalk] Deliver: no text resolved from payload");
            }
          },
          onError: (err: any) => {
            // Also cleanup on error
            cleanupTyping().catch(() => {});
            log?.info?.("[dingtalk] Reply error: " + err);
          },
        },
      });

      // Record activity
      runtime.channel?.activity?.record?.('dingtalk', account.accountId, 'message');
    } else {
      log?.info?.("[dingtalk] Runtime dispatch not available");
      await cleanupTyping();
    }
  } catch (err) {
    await cleanupTyping();
    log?.info?.("[dingtalk] Dispatch error: " + err);
  }
}

/**
 * Dispatch using the full Clawdbot Plugin SDK pipeline.
 * Uses resolveAgentRoute → session → envelope → finalizeContext → dispatch.
 */
async function dispatchWithFullPipeline(params: {
  runtime: any;
  msg: DingTalkRobotMessage;
  rawBody: string;
  account: ResolvedDingTalkAccount;
  cfg: any;
  sessionKey: string;
  isDm: boolean;
  senderId: string;
  senderName: string;
  conversationId: string;
  replyTarget: any;
  mediaPath?: string;
  mediaType?: string;
  log?: any;
  setStatus?: (update: Record<string, unknown>) => void;
  onFirstReply?: () => Promise<void>;
}): Promise<void> {
  const { runtime: rt, msg, rawBody, account, cfg, isDm,
          senderId, senderName, conversationId, replyTarget,
          log, setStatus, onFirstReply } = params;
  
  let firstReplyFired = false;

  // 1. Resolve agent route via own bindings matching (like official plugin).
  // OpenClaw's resolveAgentRoute doesn't handle accountId correctly for multi-account.
  const peerId = isDm ? senderId : conversationId;
  const peerKind = isDm ? 'dm' : 'group';
  const chatType = isDm ? 'direct' : 'group';

  let matchedAgentId: string | null = null;
  const bindings = (cfg as any)?.bindings;
  if (Array.isArray(bindings) && bindings.length > 0) {
    for (const binding of bindings) {
      const match = binding.match;
      if (!match) continue;
      if (match.channel && match.channel !== 'dingtalk') continue;
      if (match.accountId && match.accountId !== account.accountId) continue;
      if (match.peer) {
        if (match.peer.kind && match.peer.kind !== chatType) continue;
        if (match.peer.id && match.peer.id !== '*' && match.peer.id !== peerId) continue;
      }
      matchedAgentId = binding.agentId;
      break;
    }
  }
  if (!matchedAgentId) {
    matchedAgentId = (cfg as any)?.defaultAgent || 'main';
  }

  // Use OpenClaw's resolveAgentRoute with our matched agentId to get a valid sessionKey.
  // Pass accountId-prefixed peerId to ensure session isolation between accounts.
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'dingtalk',
    accountId: account.accountId,
    agentId: matchedAgentId,
    peer: { kind: peerKind, id: `${account.accountId}:${peerId}` },
  });
  const sessionKey = route.sessionKey;

  log?.info?.(`[dingtalk] Route resolved: agentId=${matchedAgentId} sessionKey=${sessionKey} accountId=${account.accountId}`);

  // 2. Resolve store path
  const storePath = rt.channel.session?.resolveStorePath?.(cfg?.session?.store, { agentId: matchedAgentId });

  // 3. Get envelope format options
  const envelopeOptions = rt.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};

  // 4. Read previous timestamp for session continuity
  const previousTimestamp = rt.channel.session?.readSessionUpdatedAt?.({ storePath, sessionKey: sessionKey });

  // 5. Format inbound envelope
  const fromLabel = isDm ? `${senderName} (${senderId})` : `${msg.conversationTitle || conversationId} - ${senderName}`;
  const body = rt.channel.reply.formatInboundEnvelope?.({
    channel: 'DingTalk', from: fromLabel, timestamp: msg.createAt, body: rawBody,
    chatType: isDm ? 'direct' : 'group', sender: { name: senderName, id: senderId },
    previousTimestamp, envelope: envelopeOptions,
  }) ?? rawBody;

  // 6. Finalize inbound context (includes media info)
  const to = isDm ? `dingtalk:${account.accountId}:dm:${senderId}` : `dingtalk:${account.accountId}:group:${conversationId}`;

  // 6a. Per-group system prompt (read from account.config.groups)
  const groupsConfig = account?.config?.groups ?? {};
  const groupOverride = !isDm ? (groupsConfig?.[conversationId] ?? {}) : {};
  const groupSystemPrompt = !isDm ? (groupOverride?.systemPrompt?.trim() || undefined) : undefined;

  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: body, RawBody: rawBody, CommandBody: rawBody, From: to, To: to,
    SessionKey: sessionKey, AccountId: account.accountId,
    ChatType: isDm ? 'direct' : 'group',
    ConversationLabel: fromLabel,
    GroupSubject: isDm ? undefined : (msg.conversationTitle || conversationId),
    SenderName: senderName, SenderId: senderId,
    Provider: 'dingtalk', Surface: 'dingtalk',
    MessageSid: msg.msgId, Timestamp: msg.createAt,
    MediaPath: params.mediaPath, MediaType: params.mediaType, MediaUrl: params.mediaPath,
    CommandAuthorized: true,
    OriginatingChannel: 'dingtalk', OriginatingTo: to,
    GroupSystemPrompt: groupSystemPrompt,
  });

  // 7. Record inbound session
  if (rt.channel.session?.recordInboundSession) {
    await rt.channel.session.recordInboundSession({
      storePath, sessionKey: ctx.SessionKey || sessionKey, ctx,
      updateLastRoute: isDm ? { sessionKey: route.mainSessionKey, channel: 'dingtalk', to: senderId, accountId: account.accountId } : undefined,
    });
  }

  // 8. Create typing-aware dispatcher
  const { dispatcher, replyOptions, markDispatchIdle } = rt.channel.reply.createReplyDispatcherWithTyping({
    responsePrefix: '',
    deliver: async (payload: any) => {
      // Recall typing indicator on first delivery
      if (!firstReplyFired && onFirstReply) {
        firstReplyFired = true;
        await onFirstReply().catch((err) => {
          log?.info?.("[dingtalk] onFirstReply error: " + err);
        });
      }
      
      try {
        log?.info?.("[dingtalk] Pipeline deliver payload keys: " + Object.keys(payload || {}).join(',') + " text?=" + (typeof payload?.text) + " markdown?=" + (typeof payload?.markdown));
        const textToSend = resolveDeliverText(payload, log);
        if (!textToSend) {
          log?.info?.("[dingtalk] Pipeline deliver: no text resolved from payload");
          return { ok: true };
        }
        await deliverReply(replyTarget, textToSend, log);
        setStatus?.({ lastOutboundAt: Date.now() });
        return { ok: true };
      } catch (err: any) {
        log?.info?.("[dingtalk] Reply delivery failed: " + err.message);
        return { ok: false, error: err.message };
      }
    },
  });

  // 9. Dispatch reply from config
  try {
    await rt.channel.reply.dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions });
  } finally {
    markDispatchIdle();
    // Recall typing indicator if no reply was sent (queued or error).
    // Note: when a message is queued (session has active run), dispatch returns
    // quickly with no delivery — this is normal, not an error. The queued message
    // will be processed after the current run completes.
    if (!firstReplyFired && onFirstReply) {
      await onFirstReply().catch(() => {});
    }
  }

  // 10. Record activity
  rt.channel?.activity?.record?.('dingtalk', account.accountId, 'message');
}

/**
 * Extract text + media URL from a deliver payload.
 * The Clawdbot platform may send media URLs in separate fields (e.g. from the `message` tool).
 * We merge them into the text as markdown image syntax so DingTalk can render them.
 */
function resolveDeliverText(payload: any, log?: any): string | undefined {
  // payload.markdown may be a boolean flag (not the actual text), so check type
  let text = (typeof payload.markdown === 'string' && payload.markdown) || payload.text;

  // Guard: ensure text is a string (platform might send unexpected types)
  if (text != null && typeof text !== 'string') {
    log?.info?.("[dingtalk] Deliver payload has non-string text type=" + typeof text + ", payload keys=" + Object.keys(payload).join(','));
    text = String(text);
  }

  const mediaUrl = payload.mediaUrl || payload.media || payload.imageUrl || payload.image;

  if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.startsWith('http')) {
    log?.info?.("[dingtalk] Deliver payload includes media URL: " + mediaUrl);
    const imageMarkdown = `![image](${mediaUrl})`;
    text = text ? `${text}\n\n${imageMarkdown}` : imageMarkdown;
  }

  return text || undefined;
}

function buildMarkdownPreviewTitle(text: string, fallback = "Jax"): string {
  if (!text) return fallback;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const raw of lines) {
    // Skip pure image lines
    if (/^!\[[^\]]*\]\([^\)]+\)$/.test(raw)) continue;

    let title = raw
      // Strip common markdown prefixes
      .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/, "")
      // Convert markdown links/images to plain text
      .replace(/!\[[^\]]*\]\([^\)]+\)/g, "")
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
      // Remove inline code fences
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

    if (!title) continue;

    // DingTalk conversation list preview is concise; keep title short.
    if (title.length > 36) title = title.slice(0, 36);
    return title;
  }

  return fallback;
}

async function deliverReply(target: any, text: string, log?: any): Promise<void> {
  const now = Date.now();
  const chunkLimit = target.account.config.textChunkLimit ?? 2000;
  const messageFormat = target.account.config.messageFormat ?? "text";
  const longTextMode = target.account.config.longTextMode ?? "chunk";
  const longTextThreshold = target.account.config.longTextThreshold ?? 4000;

  // Check if we should send as file instead of text
  if (longTextMode === 'file' && text.length > longTextThreshold) {
    log?.info?.("[dingtalk] Text exceeds threshold (" + text.length + " > " + longTextThreshold + "), sending as file");

    // Only attempt file send if we have credentials (REST API required)
    if (target.account.clientId && target.account.clientSecret) {
      const fileSent = await sendTextAsFile(target, text, log);
      if (fileSent) {
        return; // Successfully sent as file
      }
      log?.info?.("[dingtalk] File send failed, falling back to chunked text");
    } else {
      log?.info?.("[dingtalk] No credentials for file send, falling back to chunked text");
    }
  }

  // Determine if this message should use markdown format
  let isMarkdown: boolean;
  if (messageFormat === 'auto') {
    isMarkdown = detectMarkdownContent(text);
    log?.info?.("[dingtalk] Auto-detected format: " + (isMarkdown ? "markdown" : "text"));
  } else {
    // Support both "markdown" and "richtext" (they're equivalent for DingTalk)
    isMarkdown = messageFormat === "markdown" || messageFormat === "richtext";
  }

  // Convert markdown tables to text format (DingTalk doesn't support tables)
  let processedText = text;
  if (isMarkdown) {
    processedText = convertMarkdownTables(text);
    // Convert bare image URLs to markdown syntax for proper display
    processedText = convertImageUrlsToMarkdown(processedText);
  }

  // Fix DingTalk emoji rendering bug: emojis adjacent to CJK chars swallow neighbors
  processedText = fixEmojiCjkSpacing(processedText);

  const chunks: string[] = [];
  if (processedText.length <= chunkLimit) {
    chunks.push(processedText);
  } else {
    for (let i = 0; i < processedText.length; i += chunkLimit) {
      chunks.push(processedText.slice(i, i + chunkLimit));
    }
  }

  for (const chunk of chunks) {
    let webhookSuccess = false;
    const maxRetries = 2;

    // Try sessionWebhook with retry (60s safety buffer before expiry)
    if (target.sessionWebhook && now < (target.sessionWebhookExpiry - 60_000)) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          log?.info?.("[dingtalk] Using sessionWebhook (attempt " + attempt + "/" + maxRetries + "), format=" + messageFormat);
          log?.info?.("[dingtalk] Sending text (" + chunk.length + " chars): " + chunk.substring(0, 200));
          let sendResult: { ok: boolean; errcode?: number; errmsg?: string; processQueryKey?: string };
          if (isMarkdown) {
            const markdownTitle = buildMarkdownPreviewTitle(chunk, "Jax");
            sendResult = await sendMarkdownViaSessionWebhook(target.sessionWebhook, markdownTitle, chunk);
          } else {
            sendResult = await sendViaSessionWebhook(target.sessionWebhook, chunk);
          }
          if (!sendResult.ok) {
            throw new Error(`SessionWebhook rejected: errcode=${sendResult.errcode}, errmsg=${sendResult.errmsg}`);
          }
          log?.info?.("[dingtalk] SessionWebhook send OK (errcode=" + (sendResult.errcode ?? 0) + (sendResult.processQueryKey ? ` pqk=${sendResult.processQueryKey}` : '') + ")");
          // Cache outbound message so it can be resolved when quoted
          if (sendResult.processQueryKey) {
            cacheOutboundMessage(sendResult.processQueryKey, chunk);
          } else {
            // sessionWebhook doesn't return processQueryKey — cache by timestamp only
            // so interactiveCard quotes can resolve via repliedMsg.createdAt
            cacheOutboundMessageByTime(chunk);
          }
          webhookSuccess = true;
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log?.info?.("[dingtalk] SessionWebhook attempt " + attempt + " failed: " + errMsg);
          // If webhook is definitively expired/invalid, skip remaining retries
          if (errMsg.includes('880001') || errMsg.includes('invalid session') || errMsg.includes('expired') || errMsg.includes('token is not exist')) {
            log?.info?.("[dingtalk] SessionWebhook expired/invalid, falling through to REST API");
            break;
          }
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
    }

    // Fallback to REST API if webhook failed after all retries
    if (!webhookSuccess && target.account.clientId && target.account.clientSecret) {
      try {
        log?.info?.("[dingtalk] SessionWebhook unavailable, using REST API fallback");
        const restResult = await sendDingTalkRestMessage({
          clientId: target.account.clientId,
          clientSecret: target.account.clientSecret,
          robotCode: target.account.robotCode || target.account.clientId,
          userId: target.isDm ? target.senderId : undefined,
          conversationId: !target.isDm ? target.conversationId : undefined,
          text: chunk,
          format: isMarkdown ? 'markdown' : 'text',
        });
        log?.info?.("[dingtalk] REST API send OK" + (restResult.processQueryKey ? ` pqk=${restResult.processQueryKey}` : ''));
        // Cache outbound message so it can be resolved when quoted
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

/**
 * Helper function to send text as a markdown file
 * Used when longTextMode is 'file' and text exceeds threshold
 */
async function sendTextAsFile(target: any, text: string, log?: any): Promise<boolean> {
  try {
    // Generate markdown file with UTF-8 BOM for proper Chinese display
    const { buffer, fileName } = textToMarkdownFile(text, "AI Response");
    log?.info?.("[dingtalk] Converting text to file: " + fileName + " (" + buffer.length + " bytes)");

    // Upload the file
    const uploadResult = await uploadMediaFile({
      clientId: target.account.clientId,
      clientSecret: target.account.clientSecret,
      robotCode: target.account.robotCode || target.account.clientId,
      fileBuffer: buffer,
      fileName: fileName,
      fileType: 'file',
    });

    if (!uploadResult.mediaId) {
      log?.info?.("[dingtalk] File upload failed: " + (uploadResult.error || "no mediaId returned"));
      return false;
    }

    log?.info?.("[dingtalk] File uploaded, mediaId=" + uploadResult.mediaId);

    // Send the file message
    const sendResult = await sendFileMessage({
      clientId: target.account.clientId,
      clientSecret: target.account.clientSecret,
      robotCode: target.account.robotCode || target.account.clientId,
      userId: target.isDm ? target.senderId : undefined,
      conversationId: !target.isDm ? target.conversationId : undefined,
      mediaId: uploadResult.mediaId,
      fileName: fileName,
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

/**
 * Fix DingTalk emoji rendering bug: emojis adjacent to CJK characters cause
 * the renderer to "swallow" neighboring characters (e.g. "商✅化" → eats "业").
 * Solution: ensure there's a space between emoji and CJK characters.
 */
function fixEmojiCjkSpacing(text: string): string {
  // Emoji Unicode ranges (covers most common emoji blocks)
  const emojiRe = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;
  const cjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]/;

  return text.replace(emojiRe, (emoji, _m, offset, str) => {
    const before = offset > 0 ? str[offset - 1] : '';
    const after = str[offset + emoji.length] ?? '';
    const padLeft = cjkRe.test(before) && before !== ' ' ? ' ' : '';
    const padRight = cjkRe.test(after) && after !== ' ' ? ' ' : '';
    return padLeft + emoji + padRight;
  });
}


function convertImageUrlsToMarkdown(text: string): string {
  // Pattern 1: "图X: https://..." format (common Agent output)
  text = text.replace(/图(\d+):\s*(https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp)(\?[^\s]*)?)/gi, (match, num, url) => {
    return `![图${num}](${url})`;
  });

  // Pattern 2: Bare image URLs on their own line or preceded by space
  // But avoid converting URLs that are already in markdown syntax
  text = text.replace(/(?<!\]\()(?:^|\s)(https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp)(\?[^\s]*)?)/gim, (match, url) => {
    // Check if this URL is already part of markdown image syntax
    if (match.startsWith('](')) return match;
    const leadingSpace = match.match(/^\s/);
    return (leadingSpace ? leadingSpace[0] : '') + `![image](${url.trim()})`;
  });

  return text;
}

/**
 * Convert markdown tables to plain text format
 * DingTalk doesn't support markdown tables, so we convert them to readable text
 */
function convertMarkdownTables(text: string): string {
  // Match markdown tables (| col1 | col2 |\n|------|------|\n| val1 | val2 |)
  const tableRegex = /(\|.+\|\n)+/g;

  return text.replace(tableRegex, (match) => {
    const lines = match.trim().split('\n');
    if (lines.length < 2) return match;

    // Check if it's a valid table (has separator line)
    const hasSeparator = lines.some(line => /^[\s|:-]+$/.test(line.replace(/\|/g, '')));
    if (!hasSeparator) return match;

    // Convert to plain text format
    let result = '\n```\n';
    for (const line of lines) {
      // Skip separator lines (|---|---|)
      if (/^[\s|:-]+$/.test(line.replace(/\|/g, ''))) continue;

      const cells = line.split('|').map(c => c.trim()).filter(c => c);
      result += cells.join('  |  ') + '\n';
    }
    result += '```\n';
    return result;
  });
}

/**
 * Detect if text contains markdown features worth rendering as markdown.
 * Checks for headers, bold, code blocks, lists, blockquotes, links, and images.
 */
function detectMarkdownContent(text: string): boolean {
  return /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>|```|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)/m.test(text);
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalized = senderId.trim().toLowerCase();
  return allowFrom.some((entry) => {
    const e = String(entry).trim().toLowerCase();
    return e === normalized;
  });
}

function isGroupAllowed(conversationId: string, allowlist: string[]): boolean {
  if (allowlist.includes("*")) return true;
  const normalized = conversationId.trim().toLowerCase();
  return allowlist.some((entry) => {
    const e = String(entry).trim().toLowerCase();
    return e === normalized;
  });
}
