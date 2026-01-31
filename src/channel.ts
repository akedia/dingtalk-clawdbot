import { getDingTalkRuntime } from './runtime.js';
import { resolveDingTalkAccount } from './accounts.js';
import { startDingTalkMonitor } from './monitor.js';
import { sendDingTalkRestMessage, uploadMediaFile, sendFileMessage, textToMarkdownFile } from './api.js';
import { probeDingTalk } from './probe.js';

/**
 * Parse outbound `to` address, stripping optional channel prefix.
 * Handles: "dm:id", "group:id", "dingtalk:dm:id", "dingtalk:group:id",
 * and bare "id" (treated as DM userId).
 */
function parseOutboundTo(to: string): { type: string; id: string } {
  const parts = to.split(':');
  // Strip channel prefix: "dingtalk:dm:id" → "dm:id"
  if (parts[0] === 'dingtalk' && parts.length > 2) {
    parts.shift();
  }
  // Known types
  if (parts[0] === 'dm' || parts[0] === 'group') {
    return { type: parts[0], id: parts.slice(1).join(':') };
  }
  // Bare ID (no type prefix) — treat as DM userId
  return { type: 'dm', id: to };
}

export const dingtalkPlugin = {
  id: 'dingtalk',

  meta: {
    label: 'DingTalk',
    selectionLabel: 'DingTalk (钉钉)',
    detailLabel: 'DingTalk',
    blurb: 'DingTalk bot via Stream Mode (WebSocket)',
    aliases: ['dingding', 'dd'],
    order: 75,
  },

  capabilities: {
    chatTypes: ['direct', 'group'],
    media: true, // Supports images via markdown in sessionWebhook replies
    files: true, // Supports file upload and sending
    threads: false,
    reactions: false,
    mentions: true,
  },

  config: {
    schema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          title: 'Enable DingTalk',
          default: true,
        },
        clientId: {
          type: 'string',
          title: 'Client ID (AppKey)',
          description: 'DingTalk application AppKey',
        },
        clientSecret: {
          type: 'string',
          title: 'Client Secret (AppSecret)',
          description: 'DingTalk application AppSecret',
          secret: true,
        },
        robotCode: {
          type: 'string',
          title: 'Robot Code (Optional)',
          description: 'Optional robot code, defaults to Client ID',
        },
        dm: {
          type: 'object',
          title: 'Direct Message Settings',
          properties: {
            enabled: {
              type: 'boolean',
              title: 'Enable DM',
              default: true,
            },
            policy: {
              type: 'string',
              title: 'DM Access Policy',
              enum: ['disabled', 'pairing', 'allowlist', 'open'],
              default: 'pairing',
              description: 'disabled=no DM, pairing=show staffId to add, allowlist=only allowed users, open=everyone',
            },
            allowFrom: {
              type: 'array',
              title: 'Allowed Staff IDs',
              items: { type: 'string' },
              default: [],
              description: 'List of staff IDs allowed to DM the bot',
            },
          },
        },
        groupPolicy: {
          type: 'string',
          title: 'Group Chat Policy',
          enum: ['disabled', 'allowlist', 'open'],
          default: 'allowlist',
          description: 'disabled=no groups, allowlist=specific groups, open=all groups',
        },
        groupAllowlist: {
          type: 'array',
          title: 'Allowed Group IDs',
          items: { type: 'string' },
          default: [],
          description: 'List of conversation IDs for allowed groups (only used when groupPolicy is "allowlist")',
        },
        requireMention: {
          type: 'boolean',
          title: 'Require @ Mention in Groups',
          default: true,
          description: 'If true, bot only responds when @mentioned in group chats',
        },
        messageFormat: {
          type: 'string',
          title: 'Message Format',
          enum: ['text', 'markdown', 'auto'],
          default: 'text',
          description: 'text=plain text, markdown=always markdown, auto=detect markdown features in response',
        },
        showThinking: {
          type: 'boolean',
          title: 'Show Thinking Indicator',
          default: false,
          description: 'Send "正在思考..." feedback before AI processing begins',
        },
      },
      required: ['clientId', 'clientSecret'],
    },

    listAccountIds(cfg) {
      const channel = cfg?.channels?.dingtalk ?? {};
      if (channel.clientId) return ['default'];
      return [];
    },

    resolveAccount(cfg, accountId) {
      return resolveDingTalkAccount({ cfg, accountId });
    },

    defaultAccountId() {
      return 'default';
    },

    setAccountEnabled({ cfg, accountId, enabled }) {
      const runtime = getDingTalkRuntime();
      runtime.config.set('channels.dingtalk.enabled', enabled);
    },

    deleteAccount({ cfg, accountId }) {
      const runtime = getDingTalkRuntime();
      runtime.config.delete('channels.dingtalk');
    },

    isConfigured(account) {
      return !!(account.clientId && account.clientSecret);
    },

    describeAccount(account) {
      return {
        accountId: account.accountId,
        name: account.name || 'DingTalk Bot',
        enabled: account.enabled,
        configured: !!(account.clientId && account.clientSecret),
        credentialSource: account.credentialSource,
      };
    },
  },

  security: {
    resolveDmPolicy({ cfg, accountId, account }) {
      const dm = account.config.dm ?? {};
      return {
        policy: dm.policy ?? 'pairing',
        allowFrom: dm.allowFrom ?? [],
      };
    },
  },

  outbound: {
    deliveryMode: 'buffer',
    textChunkLimit: 2000,

    async sendText({ to, text, accountId, cfg }) {
      const account = resolveDingTalkAccount({ cfg, accountId });
      const { type, id } = parseOutboundTo(to);

      // Check longTextMode config
      const longTextMode = account.config?.longTextMode ?? 'chunk';
      const longTextThreshold = account.config?.longTextThreshold ?? 4000;

      // If longTextMode is 'file' and text exceeds threshold, send as file
      if (longTextMode === 'file' && text.length > longTextThreshold) {
        console.log(`[dingtalk] Outbound text exceeds threshold (${text.length} > ${longTextThreshold}), sending as file`);

        const { buffer, fileName } = textToMarkdownFile(text, 'AI Response');

        // Upload file
        const uploadResult = await uploadMediaFile({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          fileBuffer: buffer,
          fileName,
          fileType: 'file',
        });

        if (uploadResult.mediaId) {
          // Send file message
          const sendResult = await sendFileMessage({
            clientId: account.clientId,
            clientSecret: account.clientSecret,
            robotCode: account.robotCode || account.clientId,
            userId: type === 'dm' ? id : undefined,
            conversationId: type === 'group' ? id : undefined,
            mediaId: uploadResult.mediaId,
            fileName,
          });

          if (sendResult.ok) {
            console.log(`[dingtalk] File sent successfully via outbound: ${fileName}`);
            return { channel: 'dingtalk', ok: true };
          }
          console.log(`[dingtalk] File send failed, falling back to text: ${sendResult.error}`);
        } else {
          console.log(`[dingtalk] File upload failed, falling back to text: ${uploadResult.error}`);
        }
        // Fall through to text sending if file send fails
      }

      if (type === 'dm') {
        await sendDingTalkRestMessage({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          userId: id,
          text,
        });
      } else if (type === 'group') {
        await sendDingTalkRestMessage({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          conversationId: id,
          text,
        });
      }

      return { channel: 'dingtalk', ok: true };
    },

    async sendFile({ to, content, fileName, accountId, cfg }) {
      const account = resolveDingTalkAccount({ cfg, accountId });
      const { type, id } = parseOutboundTo(to);

      // Convert content to buffer if it's a string
      let fileBuffer: Buffer;
      if (typeof content === 'string') {
        // Add UTF-8 BOM for text files (better Chinese display)
        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        const textContent = Buffer.from(content, 'utf-8');
        fileBuffer = Buffer.concat([bom, textContent]);
      } else if (Buffer.isBuffer(content)) {
        fileBuffer = content;
      } else {
        throw new Error('content must be a string or Buffer');
      }

      // Upload file to DingTalk
      const uploadResult = await uploadMediaFile({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        robotCode: account.robotCode || account.clientId,
        fileBuffer,
        fileName: fileName || 'file.txt',
        fileType: 'file',
      });

      if (!uploadResult.mediaId) {
        throw new Error(`File upload failed: ${uploadResult.error}`);
      }

      // Send file message
      const sendResult = await sendFileMessage({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        robotCode: account.robotCode || account.clientId,
        userId: type === 'dm' ? id : undefined,
        conversationId: type === 'group' ? id : undefined,
        mediaId: uploadResult.mediaId,
        fileName: fileName || 'file.txt',
      });

      if (!sendResult.ok) {
        throw new Error(`File send failed: ${sendResult.error}`);
      }

      console.log(`[dingtalk] File sent via outbound.sendFile: ${fileName}`);
      return { channel: 'dingtalk', ok: true };
    },

    async sendMedia({ to, text, mediaUrl, accountId, cfg }) {
      // Note: DingTalk REST API (oToMessages/groupMessages) doesn't support markdown or images
      // Images can only be sent via sessionWebhook (when replying to messages)
      // For now, we send the image URL as a text link

      if (!mediaUrl) {
        throw new Error('mediaUrl is required for sending media on DingTalk');
      }

      // Check if URL is accessible (basic check)
      if (!mediaUrl.startsWith('http://') && !mediaUrl.startsWith('https://')) {
        throw new Error('DingTalk requires publicly accessible image URLs (http:// or https://)');
      }

      const account = resolveDingTalkAccount({ cfg, accountId });
      const { type, id } = parseOutboundTo(to);

      // Build text message with image URL as markdown image
      const imageMarkdown = `![image](${mediaUrl})`;
      const textMessage = text
        ? `${text}\n\n${imageMarkdown}`
        : imageMarkdown;

      if (type === 'dm') {
        await sendDingTalkRestMessage({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          userId: id,
          text: textMessage,
        });
      } else if (type === 'group') {
        await sendDingTalkRestMessage({
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          robotCode: account.robotCode || account.clientId,
          conversationId: id,
          text: textMessage,
        });
      }

      return { channel: 'dingtalk', ok: true };
    },
  },

  // Handle message actions (sendAttachment, etc.)
  actions: {
    // List supported actions for this channel - SDK uses this to tell agent what's available
    listActions({ cfg }: { cfg: any }) {
      return ['send', 'sendAttachment'];
    },

    supportsAction({ action }: { action: string }) {
      return action === 'sendAttachment' || action === 'send';
    },

    async handleAction(ctx: any) {
      const { action, params, cfg, accountId } = ctx;

      // Only handle sendAttachment action
      if (action !== 'sendAttachment') {
        return null; // Let SDK handle other actions
      }

      const buffer = params?.buffer;
      const filename = params?.filename || 'attachment.bin';
      const target = params?.target;

      if (!buffer || !target) {
        return null; // Let SDK handle if missing required params
      }

      const account = resolveDingTalkAccount({ cfg, accountId });
      const { type, id } = parseOutboundTo(target);

      // Decode base64 buffer
      let fileBuffer: Buffer;
      try {
        fileBuffer = Buffer.from(buffer, 'base64');
      } catch {
        return { ok: false, error: 'Invalid base64 buffer' };
      }

      // Add UTF-8 BOM for text files
      const isTextFile = /\.(txt|md|json|csv|xml|html?)$/i.test(filename);
      if (isTextFile) {
        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        // Check if BOM already exists
        if (fileBuffer[0] !== 0xEF || fileBuffer[1] !== 0xBB || fileBuffer[2] !== 0xBF) {
          fileBuffer = Buffer.concat([bom, fileBuffer]);
        }
      }

      // Upload file
      const uploadResult = await uploadMediaFile({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        robotCode: account.robotCode || account.clientId,
        fileBuffer,
        fileName: filename,
        fileType: 'file',
      });

      if (!uploadResult.mediaId) {
        console.warn(`[dingtalk] sendAttachment upload failed: ${uploadResult.error}`);
        return { ok: false, error: uploadResult.error };
      }

      // Send file
      const sendResult = await sendFileMessage({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        robotCode: account.robotCode || account.clientId,
        userId: type === 'dm' ? id : undefined,
        conversationId: type === 'group' ? id : undefined,
        mediaId: uploadResult.mediaId,
        fileName: filename,
      });

      if (!sendResult.ok) {
        console.warn(`[dingtalk] sendAttachment send failed: ${sendResult.error}`);
        return { ok: false, error: sendResult.error };
      }

      console.log(`[dingtalk] sendAttachment success: ${filename}`);
      // Return format compatible with SDK expectations
      return {
        ok: true,
        channel: 'dingtalk',
        filename,
        // SDK expects content array format for tool results
        content: [{ type: 'text', text: JSON.stringify({ ok: true, filename }) }],
      };
    },
  },

  gateway: {
    async startAccount({ account, signal, setStatus }) {
      const runtime = getDingTalkRuntime();
      const log = runtime.log?.child?.({ channel: 'dingtalk', account: account.accountId }) ?? runtime.log ?? console;
      const cfg = runtime.config;

      log.info?.('[dingtalk] Starting Stream connection...');

      // Record start activity
      (runtime as any).channel?.activity?.record?.('dingtalk', account.accountId, 'start');

      // Record stop activity on abort
      if (signal) {
        signal.addEventListener('abort', () => {
          (runtime as any).channel?.activity?.record?.('dingtalk', account.accountId, 'stop');
        }, { once: true });
      }

      try {
        await startDingTalkMonitor({
          account,
          cfg,
          abortSignal: signal,
          log,
          setStatus,
        });

        log.info?.('[dingtalk] Stream connection started successfully');
      } catch (err) {
        log.error?.('[dingtalk] Failed to start Stream', err);
        throw err;
      }
    },
  },

  status: {
    async probeAccount(account) {
      if (!account.configured || !account.clientId || !account.clientSecret) {
        return { ok: false, error: 'Not configured' };
      }

      return await probeDingTalk(account.clientId, account.clientSecret);
    },
  },

  onboarding: {
    async run(ctx: any) {
      const { onboardDingTalk } = await import('./onboarding.js');
      return onboardDingTalk(ctx);
    },
  },
};
