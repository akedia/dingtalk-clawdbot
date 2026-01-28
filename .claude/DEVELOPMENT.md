# 开发指南 - DingTalk Clawdbot Plugin

> 项目架构、技术细节和开发约定

---

## 🏗️ 架构概览

### 插件架构

```
DingTalk Plugin (@yaoyuanchao/dingtalk)
│
├── index.ts                    # 插件入口，注册 channel 和 config schema
│   └── dingTalkConfigSchema    # Zod 配置验证 schema
│
├── src/channel.ts              # ChannelPlugin 实现
│   ├── resolveAccount()        # 解析账户配置
│   ├── sendMessage()           # 发送消息（双路由）
│   ├── registerMonitor()       # 注册消息监听器
│   ├── onboarding.run()        # 配置向导
│   └── status.probeAccount()   # 健康检查
│
├── src/monitor.ts              # Stream 监听和消息处理
│   ├── DingTalkStreamMonitor   # Stream 连接管理
│   ├── handleMessage()         # 消息路由和处理
│   ├── handleImageDownload()   # 图片下载
│   └── accessControl()         # 访问控制（pairing/allowlist/open）
│
├── src/api.ts                  # DingTalk API 封装
│   ├── getDingTalkAccessToken() # 获取 access token（带缓存）
│   ├── sendDingTalkMessage()    # REST API 发送消息
│   ├── getMediaDownloadUrl()    # 获取图片下载地址
│   └── downloadMedia()          # 下载图片
│
├── src/accounts.ts             # 账户配置解析
│   └── resolveDingTalkAccount() # 解析配置（config + env）
│
├── src/config-schema.ts        # Zod 配置验证
│   ├── dingTalkConfigSchema    # 配置 schema 定义
│   └── validateDingTalkConfig() # 验证函数
│
├── src/onboarding.ts           # 交互式配置向导
│   └── onboardDingTalk()       # 分步配置流程
│
├── src/probe.ts                # 健康检查
│   └── probeDingTalk()         # 测试连接和延迟
│
├── src/types.ts                # TypeScript 类型定义
│   └── DingTalkChannelConfig   # 配置类型
│
└── src/runtime.ts              # Runtime 全局引用
    └── dingTalkRuntime         # Clawdbot runtime 实例
```

---

## 🔧 核心模块详解

### 1. 配置验证（config-schema.ts）

使用 Zod 进行类型安全的配置验证：

```typescript
export const dingTalkConfigSchema = z.object({
  enabled: z.boolean().default(true),
  clientId: z.string().min(1, 'Client ID (AppKey) is required'),
  clientSecret: z.string().min(1, 'Client Secret (AppSecret) is required'),
  robotCode: z.string().optional(),

  dm: z.object({
    enabled: z.boolean().default(true),
    policy: z.enum(['disabled', 'pairing', 'allowlist', 'open']).default('pairing'),
    allowFrom: z.array(z.string()).default([]),
  }).default({}),

  groupPolicy: z.enum(['disabled', 'allowlist', 'open']).default('allowlist'),
  groupAllowlist: z.array(z.string()).default([]),
  requireMention: z.boolean().default(true),
  messageFormat: z.enum(['text', 'markdown', 'richtext']).default('text'),
  textChunkLimit: z.number().int().positive().default(2000).optional(),
}).strict();
```

**关键设计**：
- `strict()` 模式拒绝未知字段
- 详细的错误消息（`min(1, 'error message')`）
- 合理的默认值
- 支持 `richtext` 作为 `markdown` 的 deprecated 别名

### 2. 访问控制（monitor.ts）

#### DM（私聊）策略

**pairing 模式**（推荐）：
```typescript
if (dmPolicy === 'pairing' && !allowFrom.includes(senderId)) {
  await sendPairingMessage(senderId, staffId);
  return; // 阻止消息传递，仅显示 staffId
}
```
- 首次联系时显示 staffId 和添加指引
- 管理员添加到白名单后才能正常对话

**allowlist 模式**：
```typescript
if (dmPolicy === 'allowlist' && !allowFrom.includes(senderId)) {
  return; // 直接拒绝
}
```

**open 模式**：
- 任何人都可以私聊

#### 群聊策略

**allowlist 模式**（推荐）：
```typescript
if (groupPolicy === 'allowlist' && !groupAllowlist.includes(conversationId)) {
  return; // 拒绝未授权群聊
}

if (requireMention && !message.includes('@robot')) {
  return; // 要求 @mention
}
```

**open 模式**：
- 允许所有群聊（仍可配置是否要求 @mention）

### 3. 双路由消息发送（channel.ts + api.ts）

**路由 1: SessionWebhook**（优先）
```typescript
if (sessionWebhook && !isExpired(sessionWebhook)) {
  await fetch(sessionWebhook, {
    method: 'POST',
    body: JSON.stringify({ text: message }),
  });
}
```
- 35 分钟内有效
- 支持 Markdown 格式
- 响应速度快（直接推送）

**路由 2: REST API**（兜底）
```typescript
else {
  const accessToken = await getDingTalkAccessToken();
  await sendDingTalkMessage(accessToken, conversationId, message);
}
```
- Session 过期时使用
- 仅支持纯文本
- 需要 conversationId

### 4. Access Token 管理（api.ts）

```typescript
let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getDingTalkAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const now = Date.now();

  // 检查缓存（提前 5 分钟刷新）
  if (cachedToken && cachedToken.expiresAt > now + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  // 请求新 token
  const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appKey: clientId,
      appSecret: clientSecret,
    }),
  });

  const data = await response.json();
  cachedToken = {
    token: data.accessToken,
    expiresAt: now + data.expireIn * 1000,
  };

  return cachedToken.token;
}
```

**关键点**：
- 内存缓存（7200 秒有效）
- 提前 5 分钟刷新避免过期
- 线程安全（单实例运行）

### 5. Stream 连接管理（monitor.ts）

```typescript
export class DingTalkStreamMonitor {
  private client: any; // dingtalk-stream client
  private isRunning: boolean = false;

  async start() {
    this.client = new Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      // ... other config
    });

    // 注册消息处理器
    this.client.registerCallbackListener(
      EventType.CARD_EVENT,
      async (event: any) => await this.handleMessage(event)
    );

    // 连接
    await this.client.connect();
    this.isRunning = true;
  }

  async stop() {
    if (this.client) {
      await this.client.disconnect();
      this.isRunning = false;
    }
  }
}
```

**特点**：
- WebSocket 长连接
- 自动重连（SDK 内置）
- 多种事件类型支持

---

## 🎯 关键技术决策

### 决策 1: 为什么用 Zod 而不是 JSON Schema？

**原因**：
- ✅ TypeScript 类型自动推导（`z.infer<>`）
- ✅ 更好的错误消息（可定制）
- ✅ 运行时验证 + 类型检查
- ✅ 更现代的 API（链式调用）
- ❌ JSON Schema 需要手动维护类型定义

### 决策 2: 为什么支持 richtext（deprecated）？

**原因**：
- ✅ 100% 向后兼容 v0.1.0
- ✅ 旧配置无需修改
- ✅ 代码中已有 richtext 处理逻辑
- ⚠️ 标记为 deprecated，引导迁移到 text/markdown

### 决策 3: 为什么双路由发送消息？

**原因**：
- ✅ SessionWebhook 支持 Markdown，响应快
- ✅ REST API 作为兜底，确保消息送达
- ✅ 自动选择最佳路由
- ❌ 单一路由容易失败（Session 过期）

### 决策 4: 为什么推荐 pairing 模式？

**原因**：
- ✅ 自动显示 staffId，用户体验好
- ✅ 管理员可控（白名单机制）
- ✅ 避免垃圾消息
- ❌ allowlist 需要手动获取 staffId（不友好）
- ❌ open 模式没有访问控制

---

## 🧪 测试策略

### 单元测试（TODO）

**待添加**：
- `config-schema.test.ts` - 配置验证测试
- `accounts.test.ts` - 账户解析测试
- `api.test.ts` - API 调用测试（mock）
- `probe.test.ts` - 健康检查测试

### 集成测试

**手动测试流程**：
1. 安装插件：`clawdbot plugins install @yaoyuanchao/dingtalk`
2. 运行配置向导：`clawdbot onboard --channel dingtalk`
3. 启动 Gateway：`clawdbot gateway`
4. 发送测试消息：
   - DM: 发送私聊消息，验证 pairing 模式
   - Group: 在群里 @机器人，验证消息接收
5. 验证回复：
   - 检查消息格式（text/markdown）
   - 验证图片下载
6. 健康检查：`clawdbot status --deep`

---

## 📝 代码规范

### TypeScript 编码规范

```typescript
// ✅ 好的实践
export async function sendMessage(
  config: DingTalkConfig,
  target: string,
  message: string
): Promise<void> {
  // 清晰的参数类型
  // 明确的返回类型
}

// ❌ 避免
export async function sendMessage(config: any, target: any, message: any) {
  // any 类型失去类型安全
}
```

### 错误处理

```typescript
// ✅ 好的实践
try {
  const token = await getDingTalkAccessToken(clientId, clientSecret);
} catch (error) {
  throw new Error(
    `Failed to get DingTalk access token: ${error instanceof Error ? error.message : String(error)}`
  );
}

// ❌ 避免
try {
  const token = await getDingTalkAccessToken(clientId, clientSecret);
} catch (error) {
  console.error(error); // 错误信息不清晰
  throw error;          // 没有上下文
}
```

### 配置验证

```typescript
// ✅ 好的实践
const schema = z.object({
  clientId: z.string().min(1, 'Client ID is required'),
  // 清晰的错误消息
});

try {
  return schema.parse(config);
} catch (error) {
  if (error instanceof z.ZodError) {
    const issues = error.errors.map(e =>
      `  - ${e.path.join('.')}: ${e.message}`
    ).join('\n');
    throw new Error(`Config validation failed:\n${issues}`);
  }
  throw error;
}

// ❌ 避免
const schema = z.object({
  clientId: z.string(), // 没有错误消息
});

return schema.parse(config); // 错误不友好
```

---

## 🔄 版本管理

### 语义化版本（Semantic Versioning）

- **MAJOR** (x.0.0): 不兼容的 API 变更
- **MINOR** (0.x.0): 新功能，向后兼容
- **PATCH** (0.0.x): Bug 修复，向后兼容

**当前版本**: `1.2.0`
- `1`: NPM 官方化，架构重构（从 v0.1.0 升级）
- `2`: 添加 Zod 验证、Onboarding、Probe 功能
- `0`: 无 patch 修复

### Commit Message 规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

<body>

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

**Type 类型**：
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档
- `refactor`: 重构
- `test`: 测试
- `chore`: 构建/工具

**示例**：
```
feat(config): add Zod validation for type safety

- Replace JSON Schema with Zod
- Add detailed error messages
- Maintain 100% backward compatibility

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

---

## 🚀 发布流程

### 发布 Checklist

- [ ] 更新 `package.json` 版本号
- [ ] 更新 `CHANGELOG.md`
- [ ] 本地测试通过
- [ ] 提交所有改动
- [ ] 创建 Git tag
- [ ] 推送到 GitHub
- [ ] 发布到 NPM
- [ ] 验证 NPM 包安装

### 完整发布命令

```bash
cd e:\dingtalkclawd

# 1. 更新版本号
npm version patch  # 或 minor/major

# 2. 构建和测试
npm pack
tar -tzf yaoyuanchao-dingtalk-*.tgz

# 3. 提交改动
git add .
git commit -m "chore: release vX.X.X"

# 4. 创建标签
git tag vX.X.X

# 5. 推送到 GitHub
git push origin main
git push origin vX.X.X

# 6. 发布到 NPM
npm publish --access public

# 7. 验证
npm view @yaoyuanchao/dingtalk version
clawdbot plugins install @yaoyuanchao/dingtalk
```

---

## 🐛 调试技巧

### 本地调试

```bash
# 1. 克隆项目
cd e:\dingtalkclawd

# 2. 安装依赖
npm install

# 3. 本地打包
npm pack

# 4. 安装到本地 Clawdbot
clawdbot plugins install ./yaoyuanchao-dingtalk-1.2.0.tgz

# 5. 查看日志
tail -f C:\Users\你的用户名\.clawdbot\logs\clawdbot-*.log
```

### 远端调试

```bash
# 查看详细日志
ssh root@172.20.90.45 "tail -100 /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log"

# 实时监控
ssh root@172.20.90.45 "tail -f /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log | grep dingtalk"

# 检查进程
ssh root@172.20.90.45 "ps aux | grep clawdbot"

# 检查配置
ssh root@172.20.90.45 "cat /home/clawd/.clawdbot/clawdbot.json | jq '.channels.dingtalk'"
```

### 常见问题调试

**问题 1: 配置验证失败**
```bash
# 查看详细错误
clawdbot doctor

# 检查 schema
cat e:\dingtalkclawd\src\config-schema.ts
```

**问题 2: Stream 连接失败**
```bash
# 检查凭证
echo $DINGTALK_CLIENT_ID
echo $DINGTALK_CLIENT_SECRET

# 测试 API
curl -X POST https://api.dingtalk.com/v1.0/oauth2/accessToken \
  -H "Content-Type: application/json" \
  -d '{"appKey":"你的clientId","appSecret":"你的clientSecret"}'
```

**问题 3: 消息发送失败**
```bash
# 查看日志中的 SessionWebhook
grep 'sessionWebhook' /tmp/clawdbot/clawdbot-*.log

# 查看日志中的 conversationId
grep 'conversationId' /tmp/clawdbot/clawdbot-*.log
```

---

## 📚 相关资源

### DingTalk API 文档
- **Stream 模式**: https://open.dingtalk.com/document/orgapp/stream-overview
- **Access Token**: https://open.dingtalk.com/document/orgapp/obtain-orgapp-token
- **发送消息**: https://open.dingtalk.com/document/orgapp/chatbot-send-one-on-one-chat-messages-in-batches
- **下载图片**: https://open.dingtalk.com/document/orgapp/download-media-files

### Clawdbot 插件开发
- **插件系统**: （需要官方文档链接）
- **ChannelPlugin 接口**: （需要官方文档链接）

### 工具和库
- **Zod**: https://zod.dev/
- **dingtalk-stream**: https://www.npmjs.com/package/dingtalk-stream
- **TypeScript**: https://www.typescriptlang.org/

---

**最后更新**: 2026-01-28
**维护者**: yaoyuanchao
