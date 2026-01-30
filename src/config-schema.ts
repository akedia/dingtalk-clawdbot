import { z } from 'zod';

// 定义枚举类型
export const dmPolicySchema = z.enum(['disabled', 'pairing', 'allowlist', 'open'], {
  description: 'DM access control policy',
});

export const groupPolicySchema = z.enum(['disabled', 'allowlist', 'open'], {
  description: 'Group chat access control policy',
});

export const messageFormatSchema = z.enum(['text', 'markdown', 'richtext', 'auto'], {
  description: 'Message format for bot responses (richtext is an alias for markdown, auto detects markdown features)',
});

// DingTalk 配置 Schema
export const dingTalkConfigSchema = z.object({
  enabled: z.boolean().default(true).describe('Enable DingTalk channel'),

  // 凭证配置（必需）
  clientId: z.string().min(1, 'Client ID (AppKey) is required')
    .describe('DingTalk application AppKey'),
  clientSecret: z.string().min(1, 'Client Secret (AppSecret) is required')
    .describe('DingTalk application AppSecret'),
  robotCode: z.string().optional()
    .describe('Robot code (optional, defaults to clientId if not provided)'),

  // 私聊配置
  dm: z.object({
    enabled: z.boolean().default(true)
      .describe('Enable direct messages'),
    policy: dmPolicySchema.default('pairing')
      .describe(
        'Access control policy:\n' +
        '  - disabled: No DM allowed\n' +
        '  - pairing: Show staffId on first contact, admin adds to allowlist\n' +
        '  - allowlist: Only specified users can DM\n' +
        '  - open: Anyone can DM (not recommended)'
      ),
    allowFrom: z.array(z.string()).default([])
      .describe('Allowed staff IDs (for pairing/allowlist policy)'),
  }).default({}),

  // 群聊配置
  groupPolicy: groupPolicySchema.default('allowlist')
    .describe(
      'Group chat policy:\n' +
      '  - disabled: No groups\n' +
      '  - allowlist: Only specified groups\n' +
      '  - open: All groups'
    ),
  groupAllowlist: z.array(z.string()).default([])
    .describe('Allowed group conversation IDs (only used when groupPolicy is "allowlist")'),
  requireMention: z.boolean().default(true)
    .describe('Require @ mention in group chats'),

  // 消息格式
  messageFormat: messageFormatSchema.default('text')
    .describe(
      'Message format:\n' +
      '  - text: Plain text (recommended, supports tables)\n' +
      '  - markdown: DingTalk markdown (limited support, no tables)\n' +
      '  - richtext: Alias for markdown (deprecated, use markdown instead)\n' +
      '  - auto: Auto-detect markdown features in response'
    ),

  // 思考反馈
  showThinking: z.boolean().default(false)
    .describe('Send "正在思考..." feedback before AI responds'),

  // 高级配置（可选）
  textChunkLimit: z.number().int().positive().default(2000).optional()
    .describe('Text chunk size limit for long messages'),
}).strict();

// 导出配置类型
export type DingTalkConfig = z.infer<typeof dingTalkConfigSchema>;

/**
 * 验证 DingTalk 配置
 * @param config - 原始配置对象
 * @returns 验证后的配置
 * @throws ZodError 如果配置无效
 */
export function validateDingTalkConfig(config: unknown): DingTalkConfig {
  try {
    return dingTalkConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = error.issues.map(e => {
        const path = e.path.join('.');
        return `  - ${path || 'root'}: ${e.message}`;
      }).join('\n');
      throw new Error(`DingTalk config validation failed:\n${formatted}`);
    }
    throw error;
  }
}

/**
 * 安全地验证配置，返回错误而不抛出异常
 * @param config - 原始配置对象
 * @returns { success: true, data } 或 { success: false, error }
 */
export function safeValidateDingTalkConfig(config: unknown):
  | { success: true; data: DingTalkConfig }
  | { success: false; error: string } {
  try {
    const data = dingTalkConfigSchema.parse(config);
    return { success: true, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = error.issues.map(e => {
        const path = e.path.join('.');
        return `${path || 'root'}: ${e.message}`;
      }).join('; ');
      return { success: false, error: formatted };
    }
    return { success: false, error: String(error) };
  }
}
