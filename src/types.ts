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
  text?: { content: string; isReplyMsg?: boolean; repliedMsg?: any };
  richText?: unknown;
  picture?: { downloadCode: string };
  /** Link card message content */
  link?: { title?: string; text?: string; messageUrl?: string; picUrl?: string };
  /** Generic content field used by audio/video/file message types */
  content?: any;
  atUsers?: Array<{ dingtalkId: string; staffId?: string }>;
  isInAtList?: boolean;
  conversationTitle?: string;
  senderPlatform?: string;
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

/** Extracted message content from DingTalk */
export interface ExtractedMessage {
  /** Textual representation of the message */
  text: string;
  /** Download code for media (picture/audio/video/file) */
  mediaDownloadCode?: string;
  /** Media type category */
  mediaType?: 'image' | 'audio' | 'video' | 'file';
  /** Original file name (for file messages) */
  mediaFileName?: string;
  /** Original DingTalk msgtype */
  messageType: string;
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
  messageFormat?: 'text' | 'markdown' | 'richtext' | 'auto';
  showThinking?: boolean;
  [key: string]: unknown;
}
