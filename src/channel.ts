import { getDingTalkRuntime } from './runtime.js';
import { resolveDingTalkAccount } from './accounts.js';
import { startDingTalkMonitor } from './monitor.js';
import { sendDingTalkRestMessage } from './api.js';
import { probeDingTalk } from './probe.js';

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
          enum: ['text', 'markdown'],
          default: 'text',
          description: 'text=plain text, markdown=DingTalk markdown (limited: no tables, use text for tables)',
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
      const [type, id] = to.split(':');

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
      const [type, id] = to.split(':');

      // Build text message with image URL
      const textMessage = text
        ? `${text}\n\n图片链接: ${mediaUrl}`
        : `图片链接: ${mediaUrl}`;

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

  gateway: {
    async startAccount({ account, signal, setStatus }) {
      const runtime = getDingTalkRuntime();
      const log = runtime.log?.child?.({ channel: 'dingtalk', account: account.accountId }) ?? runtime.log ?? console;
      const cfg = runtime.config;

      log.info?.('[dingtalk] Starting Stream connection...');

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
