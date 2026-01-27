import type { DingTalkRobotMessage, ResolvedDingTalkAccount } from "./types.js";
import { sendViaSessionWebhook, sendMarkdownViaSessionWebhook, sendDingTalkRestMessage, batchGetUserInfo, downloadPicture, cleanupOldPictures } from "./api.js";
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
  cleanupOldPictures();

  // Schedule periodic cleanup every hour
  const cleanupInterval = setInterval(() => {
    cleanupOldPictures();
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

  // Extract message content from text or richText
  let rawBody = msg.text?.content?.trim() ?? "";

  // If text is empty, try to extract from richText
  if (!rawBody && msg.richText) {
    try {
      const richTextStr = typeof msg.richText === 'string'
        ? msg.richText
        : JSON.stringify(msg.richText);
      log?.info?.("[dingtalk] Received richText message (full): " + richTextStr);

      const rt = msg.richText as any;

      // Try multiple possible fields for text content
      if (typeof msg.richText === 'string') {
        // If it's a string, use it directly
        rawBody = msg.richText.trim();
      } else if (rt) {
        // Try various possible field names
        rawBody = rt.text?.trim()
          || rt.content?.trim()
          || rt.richText?.trim()
          || "";

        // If still empty, try to extract from richText array structure
        if (!rawBody && Array.isArray(rt.richText)) {
          const textParts: string[] = [];
          for (const item of rt.richText) {
            // Handle different types of richText elements
            if (item.text) {
              textParts.push(item.text);
            } else if (item.content) {
              textParts.push(item.content);
            }
            // Note: @mention text should be included in item.text by DingTalk
          }
          rawBody = textParts.join('').trim();
        }
      }

      if (rawBody) {
        log?.info?.("[dingtalk] Extracted from richText: " + rawBody.slice(0, 100));
      }
    } catch (err) {
      log?.info?.("[dingtalk] Failed to parse richText: " + err);
    }
  }

  // Additional fallback: try to get content from text.content even for richText messages
  if (!rawBody && msg.text?.content) {
    rawBody = msg.text.content.trim();
    log?.info?.("[dingtalk] Using text.content as fallback: " + rawBody.slice(0, 100));
  }

  // Handle richText messages (when msgtype === 'richText', data is in msg.content.richText)
  if (!rawBody && msg.msgtype === 'richText') {
    const content = (msg as any).content;
    log?.info?.("[dingtalk] RichText message - msg.content: " + JSON.stringify(content).substring(0, 200));

    if (content?.richText && Array.isArray(content.richText)) {
      const parts: string[] = [];

      for (const item of content.richText) {
        if (item.msgType === "text" && item.content) {
          parts.push(item.content);
        } else if ((item.msgType === "picture" || item.pictureDownloadCode || item.downloadCode) && (item.downloadCode || item.pictureDownloadCode)) {
          // Handle picture: msgType may be absent, check for downloadCode fields
          const downloadCode = item.downloadCode || item.pictureDownloadCode;
          // Download the picture from richText message
          try {
            const robotCode = account.robotCode || account.clientId;
            const pictureResult = await downloadPicture(
              account.clientId,
              account.clientSecret,
              robotCode,
              downloadCode,
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

      rawBody = parts.join("");
      if (rawBody) {
        log?.info?.("[dingtalk] Extracted from msg.content.richText: " + rawBody.substring(0, 100));
      }
    }
  }

  // Handle picture messages
  if (!rawBody && msg.msgtype === 'picture') {
    log?.info?.("[dingtalk] Picture message - msg.picture: " + JSON.stringify(msg.picture));
    log?.info?.("[dingtalk] Picture message - msg.content: " + JSON.stringify((msg as any).content));
    log?.info?.("[dingtalk] Full msg keys: " + Object.keys(msg).join(', '));

    const content = (msg as any).content;
    let downloadCode: string | undefined;

    if (msg.picture?.downloadCode) {
      downloadCode = msg.picture.downloadCode;
    } else if (content?.downloadCode) {
      downloadCode = content.downloadCode;
    }

    if (downloadCode) {
      log?.info?.("[dingtalk] Picture detected, downloadCode: " + downloadCode);

      // Try to download the picture
      try {
        const robotCode = account.robotCode || account.clientId;
        const pictureResult = await downloadPicture(
          account.clientId,
          account.clientSecret,
          robotCode,
          downloadCode,
        );

        if (pictureResult.error) {
          rawBody = `[用户发送了图片，但下载失败: ${pictureResult.error}]`;
          log?.warn?.("[dingtalk] Picture download failed: " + pictureResult.error);
        } else if (pictureResult.filePath) {
          rawBody = `[用户发送了图片]\n图片已保存到: ${pictureResult.filePath}`;
          log?.info?.("[dingtalk] Picture downloaded successfully: " + pictureResult.filePath);

          // Note: If Agent supports multimodal input, we could pass the base64 or file path
          // For now, we just notify the agent that a picture was sent
        } else {
          rawBody = "[用户发送了图片，但无法获取下载链接]";
        }
      } catch (err) {
        rawBody = `[用户发送了图片，下载时出错: ${err}]`;
        log?.warn?.("[dingtalk] Error downloading picture: " + err);
      }
    } else {
      // Even if we can't get picture info, allow the message through
      rawBody = "[用户发送了图片(无法获取下载码)]";
      log?.info?.("[dingtalk] Picture msgtype but no downloadCode found");
    }
  }

  if (!rawBody) {
    log?.info?.("[dingtalk] Empty message body after all attempts, skipping. msgtype=" + msg.msgtype + ", hasText=" + !!msg.text + ", hasRichText=" + !!msg.richText + ", hasPicture=" + !!msg.picture);
    return;
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
        // Batch query user info with 500ms timeout
        const userInfoMap = await batchGetUserInfo(account.clientId, account.clientSecret, userIds, 500);

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

  // Load actual config if cfg is a config manager
  let actualCfg = cfg;
  if (cfg && typeof cfg.loadConfig === "function") {
    try {
      actualCfg = await cfg.loadConfig();
      console.warn("[dingtalk-debug] Loaded actual config, agents.defaults.model:", JSON.stringify(actualCfg?.agents?.defaults?.model, null, 2));
    } catch (err) {
      console.warn("[dingtalk-debug] Failed to load config:", err);
    }
  }

  try {
    if (runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
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
      };

      // Fire-and-forget: don't await to avoid blocking SDK callback during long agent runs
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: actualCfg,
        dispatcherOptions: {
          deliver: async (payload: any) => {
            if (payload.text) {
              await deliverReply(replyTarget, payload.text, log);
              setStatus?.({ lastOutboundAt: Date.now() });
            }
          },
          onError: (err: any) => {
            log?.info?.("[dingtalk] Reply error: " + err);
          },
        },
      }).catch((err) => {
        log?.info?.("[dingtalk] Dispatch failed: " + err);
      });
    } else {
      log?.info?.("[dingtalk] Runtime dispatch not available");
    }
  } catch (err) {
    log?.info?.("[dingtalk] Dispatch error: " + err);
  }
}

async function deliverReply(target: any, text: string, log?: any): Promise<void> {
  const now = Date.now();
  const chunkLimit = 2000;
  const messageFormat = target.account.config.messageFormat ?? "text";
  // Support both "markdown" and "richtext" (they're equivalent for DingTalk)
  const isMarkdown = messageFormat === "markdown" || messageFormat === "richtext";

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
          log?.info?.("[dingtalk] Sending text: " + chunk.substring(0, 200));
          if (isMarkdown) {
            await sendMarkdownViaSessionWebhook(target.sessionWebhook, "Reply", chunk);
          } else {
            await sendViaSessionWebhook(target.sessionWebhook, chunk);
          }
          log?.info?.("[dingtalk] SessionWebhook send OK");
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
