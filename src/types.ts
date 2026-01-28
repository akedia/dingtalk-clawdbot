/** Inbound robot message from DingTalk Stream SDK */
export interface DingTalkRobotMessage {
  conversationId: string;
  chatbotCorpId: string;
  chatbotUserId: string;
  msgId: string;
  senderNick: string;
  isAdmin: boolean;
  senderStaffId: string;
  sessionWebhookExpiredTime: number;
  createAt: number;
  senderCorpId: string;
  conversationType: string; // "1" = DM, "2" = group
  senderId: string;
  sessionWebhook: string;
  robotCode: string;
  msgtype: string;
  text?: { content: string };
  richText?: unknown;
  picture?: { downloadCode: string };
  atUsers?: Array<{ dingtalkId: string; staffId?: string }>;
  isInAtList?: boolean;
  conversationTitle?: string;
}

/** Resolved account for DingTalk */
export interface ResolvedDingTalkAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  clientId?: string;
  clientSecret?: string;
  robotCode?: string;
  credentialSource: "config" | "env" | "none";
  config: Record<string, any>;
}

/** DingTalk channel config shape */
export interface DingTalkChannelConfig {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  robotCode?: string;
  dm?: {
    enabled?: boolean;
    policy?: string;
    allowFrom?: string[];
  };
  groupPolicy?: string;
  groupAllowlist?: string[];
  requireMention?: boolean;
  textChunkLimit?: number;
  messageFormat?: 'text' | 'markdown' | 'richtext';
  [key: string]: unknown;
}
