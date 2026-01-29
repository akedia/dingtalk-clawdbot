import type { DingTalkRobotMessage, ResolvedDingTalkAccount, ExtractedMessage } from "./types.js";
import { sendViaSessionWebhook, sendMarkdownViaSessionWebhook, sendDingTalkRestMessage, batchGetUserInfo, downloadPicture, downloadMediaFile, cleanupOldMedia } from "./api.js";
import { getDingTalkRuntime } from "./runtime.js";

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

  // Clean up on abort (only if abortSignal is provided)
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => {
      clearInterval(cleanupInterval);
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
  });

  client.registerCallbackListener(TOPIC_ROBOT, async (downstream: any) => {
    // Immediately ACK to prevent DingTalk from retrying (60s timeout)
    // SDK method is socketCallBackResponse, not socketResponse
    try {
      client.socketCallBackResponse(downstream.headers.messageId, { status: 'SUCCESS' });
    } catch (_) { /* best-effort ACK */ }

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

  const onAbort = () => {
    try { client.disconnect?.(); } catch {}
    setStatus?.({ running: false, lastStopAt: Date.now() });
  };
  if (abortSignal) {
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  await client.connect();
  log?.info?.("[dingtalk:" + account.accountId + "] Stream connected");
  setStatus?.({ running: true, lastStartAt: Date.now() });
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

            const formattedRecords = records.map((record, idx) => {
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
                  msgContent = '[图片]';
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
            });
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

  // Debug: log full message structure for debugging
  if (msg.msgtype === 'richText' || msg.picture || (msg.atUsers && msg.atUsers.length > 0)) {
    log?.info?.("[dingtalk-debug] Full message structure:");
    log?.info?.("[dingtalk-debug]   msgtype: " + msg.msgtype);
    log?.info?.("[dingtalk-debug]   text: " + JSON.stringify(msg.text));
    log?.info?.("[dingtalk-debug]   richText: " + JSON.stringify(msg.richText));
    log?.info?.("[dingtalk-debug]   picture: " + JSON.stringify(msg.picture));
    log?.info?.("[dingtalk-debug]   atUsers: " + JSON.stringify(msg.atUsers));
    log?.info?.("[dingtalk-debug]   RAW MESSAGE: " + JSON.stringify(msg).substring(0, 500));
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

  let rawBody = extracted.text;

  if (!rawBody && !mediaPath) {
    log?.info?.("[dingtalk] Empty message body after all attempts, skipping. msgtype=" + msg.msgtype);
    return;
  }

  // If we have media but no text, provide a placeholder
  if (!rawBody && mediaPath) {
    rawBody = `[${extracted.messageType}] 媒体文件已下载: ${mediaPath}`;
  }

  // Handle quoted/replied messages: extract the quoted content and prepend it
  if (msg.text && (msg.text as any).isReplyMsg) {
    log?.info?.("[dingtalk] Message is a reply, full text object: " + JSON.stringify(msg.text));

    if ((msg.text as any).repliedMsg) {
      try {
        const repliedMsg = (msg.text as any).repliedMsg;
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
        }

        if (quotedContent) {
          rawBody = `[引用回复: "${quotedContent.trim()}"]\n${rawBody}`;
          log?.info?.("[dingtalk] Added quoted message: " + quotedContent.slice(0, 50));
        } else {
          log?.info?.("[dingtalk] Reply message found but no content extracted, repliedMsg: " + JSON.stringify(repliedMsg));
        }
      } catch (err) {
        log?.info?.("[dingtalk] Failed to extract quoted message: " + err);
      }
    } else {
      log?.info?.("[dingtalk] Message marked as reply but no repliedMsg field found");
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

  // Send thinking feedback (opt-in)
  if (account.config.showThinking && msg.sessionWebhook) {
    try {
      await sendViaSessionWebhook(msg.sessionWebhook, '正在思考...');
      log?.info?.('[dingtalk] Sent thinking indicator');
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

  try {
    if (hasFullPipeline) {
      // Full SDK pipeline: route → session → envelope → dispatch
      await dispatchWithFullPipeline({
        runtime, msg, rawBody, account, cfg: actualCfg, sessionKey, isDm,
        senderId, senderName, conversationId, replyTarget,
        mediaPath, mediaType, log, setStatus,
      });
    } else if (runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
      // Fallback: existing buffered block dispatcher
      const ctxPayload = {
        Body: rawBody,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: "dingtalk:" + senderId,
        To: isDm ? ("dingtalk:dm:" + senderId) : ("dingtalk:group:" + conversationId),
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
      };

      // Fire-and-forget: don't await to avoid blocking SDK callback during long agent runs
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: actualCfg,
        dispatcherOptions: {
          deliver: async (payload: any) => {
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
            log?.info?.("[dingtalk] Reply error: " + err);
          },
        },
      }).catch((err) => {
        log?.info?.("[dingtalk] Dispatch failed: " + err);
      });

      // Record activity
      runtime.channel?.activity?.record?.('dingtalk', account.accountId, 'message');
    } else {
      log?.info?.("[dingtalk] Runtime dispatch not available");
    }
  } catch (err) {
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
}): Promise<void> {
  const { runtime: rt, msg, rawBody, account, cfg, isDm,
          senderId, senderName, conversationId, replyTarget,
          log, setStatus } = params;

  // 1. Resolve agent route
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'dingtalk',
    accountId: account.accountId,
    peer: { kind: isDm ? 'dm' : 'group', id: isDm ? senderId : conversationId },
  });

  // 2. Resolve store path
  const storePath = rt.channel.session?.resolveStorePath?.(cfg?.session?.store, { agentId: route.agentId });

  // 3. Get envelope format options
  const envelopeOptions = rt.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};

  // 4. Read previous timestamp for session continuity
  const previousTimestamp = rt.channel.session?.readSessionUpdatedAt?.({ storePath, sessionKey: route.sessionKey });

  // 5. Format inbound envelope
  const fromLabel = isDm ? `${senderName} (${senderId})` : `${msg.conversationTitle || conversationId} - ${senderName}`;
  const body = rt.channel.reply.formatInboundEnvelope?.({
    channel: 'DingTalk', from: fromLabel, timestamp: msg.createAt, body: rawBody,
    chatType: isDm ? 'direct' : 'group', sender: { name: senderName, id: senderId },
    previousTimestamp, envelope: envelopeOptions,
  }) ?? rawBody;

  // 6. Finalize inbound context (includes media info)
  const to = isDm ? `dingtalk:${senderId}` : `dingtalk:group:${conversationId}`;
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: body, RawBody: rawBody, CommandBody: rawBody, From: to, To: to,
    SessionKey: route.sessionKey, AccountId: account.accountId,
    ChatType: isDm ? 'direct' : 'group',
    ConversationLabel: fromLabel,
    GroupSubject: isDm ? undefined : (msg.conversationTitle || conversationId),
    SenderName: senderName, SenderId: senderId,
    Provider: 'dingtalk', Surface: 'dingtalk',
    MessageSid: msg.msgId, Timestamp: msg.createAt,
    MediaPath: params.mediaPath, MediaType: params.mediaType, MediaUrl: params.mediaPath,
    CommandAuthorized: true,
    OriginatingChannel: 'dingtalk', OriginatingTo: to,
  });

  // 7. Record inbound session
  if (rt.channel.session?.recordInboundSession) {
    await rt.channel.session.recordInboundSession({
      storePath, sessionKey: ctx.SessionKey || route.sessionKey, ctx,
      updateLastRoute: isDm ? { sessionKey: route.mainSessionKey, channel: 'dingtalk', to: senderId, accountId: account.accountId } : undefined,
    });
  }

  // 8. Create typing-aware dispatcher
  const { dispatcher, replyOptions, markDispatchIdle } = rt.channel.reply.createReplyDispatcherWithTyping({
    responsePrefix: '',
    deliver: async (payload: any) => {
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

async function deliverReply(target: any, text: string, log?: any): Promise<void> {
  const now = Date.now();
  const chunkLimit = 2000;
  const messageFormat = target.account.config.messageFormat ?? "text";

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

    // Try sessionWebhook with retry
    if (target.sessionWebhook && now < target.sessionWebhookExpiry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          log?.info?.("[dingtalk] Using sessionWebhook (attempt " + attempt + "/" + maxRetries + "), format=" + messageFormat);
          log?.info?.("[dingtalk] Sending text (" + chunk.length + " chars): " + chunk.substring(0, 200));
          let sendResult: { ok: boolean; errcode?: number; errmsg?: string };
          if (isMarkdown) {
            sendResult = await sendMarkdownViaSessionWebhook(target.sessionWebhook, "Reply", chunk);
          } else {
            sendResult = await sendViaSessionWebhook(target.sessionWebhook, chunk);
          }
          if (!sendResult.ok) {
            throw new Error(`SessionWebhook rejected: errcode=${sendResult.errcode}, errmsg=${sendResult.errmsg}`);
          }
          log?.info?.("[dingtalk] SessionWebhook send OK (errcode=" + (sendResult.errcode ?? 0) + ")");
          webhookSuccess = true;
          break;
        } catch (err) {
          log?.info?.("[dingtalk] SessionWebhook attempt " + attempt + " failed: " + (err instanceof Error ? err.message : String(err)));
          if (attempt < maxRetries) {
            // Wait 1 second before retry
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
    }

    // Fallback to REST API if webhook failed after all retries
    if (!webhookSuccess && target.account.clientId && target.account.clientSecret) {
      try {
        log?.info?.("[dingtalk] SessionWebhook failed after " + maxRetries + " attempts, using REST API fallback");
        // REST API only supports text format
        const textChunk = messageFormat === "markdown" ? chunk : chunk;
        await sendDingTalkRestMessage({
          clientId: target.account.clientId,
          clientSecret: target.account.clientSecret,
          robotCode: target.account.robotCode || target.account.clientId,
          userId: target.isDm ? target.senderId : undefined,
          conversationId: !target.isDm ? target.conversationId : undefined,
          text: textChunk,
        });
        log?.info?.("[dingtalk] REST API send OK");
      } catch (err) {
        log?.info?.("[dingtalk] REST API also failed: " + (err instanceof Error ? err.stack : JSON.stringify(err)));
      }
    } else if (!webhookSuccess) {
      log?.info?.("[dingtalk] No delivery method available!");
    }
  }
}

/**
 * Convert bare image URLs to markdown image syntax
 * Detects patterns like "图1: https://..." or "https://...png" and converts to ![](url)
 */
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
