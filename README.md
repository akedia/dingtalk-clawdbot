# Clawdbot DingTalk Channel Plugin

钉钉（DingTalk）频道插件，支持通过 Stream 模式接收和回复私聊及群聊消息。

## ⚠️ 重要：分享此插件时的注意事项

**只分享 `extensions/dingtalk/` 目录，不要分享以下敏感文件：**

- ❌ `clawdbot.json` - 包含 API Key、DingTalk 凭证、staffId
- ❌ `.env` 文件 - 环境变量配置
- ❌ 任何包含真实凭证的文件

**如果不小心分享了配置文件，可能导致：**
1. 他人消耗你的 API 额度
2. 多个实例连接同一个机器人，消息串台
3. 隐私泄露和安全风险

**正确的分享方式：**
```bash
# 只复制插件源代码目录
cp -r extensions/dingtalk /path/to/share/

# 确认不包含敏感文件
ls /path/to/share/dingtalk/  # 应该只看到 src/, package.json, README.md 等
```

其他人拿到插件后，需要使用**自己的 DingTalk 应用凭证**配置。

---

## 功能特性

- ✅ Stream 模式连接（无需公网域名）
- ✅ 私聊消息支持（DM）
- ✅ 群聊消息支持（@机器人）
- ✅ Pairing 模式访问控制
- ✅ SessionWebhook 优先回复（35分钟内快速响应）
- ✅ REST API 兜底回复

## 前置要求

1. 钉钉企业内部应用（已创建并配置 Stream 模式）
2. Node.js 环境（clawdbot 已安装）
3. 应用的 AppKey (clientId) 和 AppSecret (clientSecret)

## 安装步骤

### 1. 复制插件文件

将整个 `dingtalk` 目录复制到你的 clawdbot 扩展目录：

```bash
# Linux/Mac
cp -r dingtalk ~/.clawdbot/extensions/

# Windows
xcopy /E /I dingtalk %USERPROFILE%\.clawdbot\extensions\dingtalk
```

### 2. 安装依赖

```bash
cd ~/.clawdbot/extensions/dingtalk
npm install
```

### 3. 配置 clawdbot.json

编辑 `~/.clawdbot/clawdbot.json`，添加 DingTalk 频道配置：

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingXXXXXXXXXXXXXXXX",
      "clientSecret": "YOUR_APP_SECRET_HERE",
      "dm": {
        "policy": "pairing",
        "allowFrom": ["YOUR_STAFF_ID"]
      },
      "groupPolicy": "allowlist",
      "groupAllowlist": ["cidlnNrtqQ4kGskU56Qni6zTg=="],
      "requireMention": true
    }
  }
}
```

**配置说明**：
- `clientId`: 钉钉应用的 AppKey
- `clientSecret`: 钉钉应用的 AppSecret
- `dm.policy`: 私聊策略
  - `"pairing"`: 需要明确允许的用户才能使用（推荐）
  - `"open"`: 任何人都可以私聊
  - `"disabled"`: 禁用私聊
- `dm.allowFrom`: 允许私聊的 staffId 列表（当 policy 为 pairing 时生效）
- `groupPolicy`: 群聊策略
  - `"allowlist"`: 仅允许列表中的群
  - `"open"`: 允许所有群
  - `"disabled"`: 禁用群聊
- `groupAllowlist`: 允许的群聊 conversationId 列表（当 groupPolicy 为 allowlist 时生效）
- `requireMention`: 是否要求在群聊中 @机器人（推荐 true）
- `messageFormat`: 消息格式（可选）
  - `"text"`: 纯文本格式（默认，推荐）
  - `"markdown"`: Markdown 格式（⚠️ 钉钉仅支持有限的 Markdown 语法，**不支持表格**）

**Markdown 格式说明**：
- ✅ 支持：标题、粗体、斜体、链接、图片、引用、列表、代码块
- ❌ 不支持：**表格**、复杂嵌套列表、HTML 标签、任务列表
- 📝 自动转换：插件会自动将 Markdown 表格转换为纯文本代码块显示
- ⏰ 仅 SessionWebhook 可用：REST API 兜底时自动降级为纯文本

**配置示例**：
```json
{
  "messageFormat": "markdown"
}
```

### 4. 启动 clawdbot gateway

```bash
# 如果已经在运行，需要重启
clawdbot gateway restart

# 或者首次启动
clawdbot gateway
```

### 5. 查看日志验证

```bash
# 查看实时日志
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep dingtalk

# 成功的标志：
# [dingtalk:default] Starting Stream...
# [dingtalk:default] Stream connected
# [dingtalk] Stream connection started successfully
```

## 获取你的 staffId

首次使用时，机器人会告诉你的 staffId：

1. 在钉钉中找到机器人
2. 发送任意消息
3. 机器人会回复："Access denied. Your staffId: 050914185922786044 Ask admin to add you."
4. 将这个 staffId 添加到配置文件的 `dm.allowFrom` 数组中
5. 重启 gateway

## 获取群聊 conversationId

如果使用 `groupPolicy: "allowlist"`,需要获取群聊的 conversationId：

**方法1: 查看日志**
1. 在群聊中 @机器人发送消息
2. 查看 gateway 日志：
```bash
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep "dingtalk.*Group"
```
3. 日志会显示：`[dingtalk] Group from XXX: ...` 以及相关的 conversationId
4. 或者查看日志中的 "Group not in allowlist" 消息获取 conversationId

**方法2: 临时设置为 open**
1. 临时修改配置为 `groupPolicy: "open"`
2. 重启 gateway
3. 在群聊中 @机器人发送消息
4. 查看日志获取 conversationId（格式类似 `cidlnNrtqQ4kGskU56Qni6zTg==`）
5. 将 conversationId 添加到 `groupAllowlist` 数组
6. 改回 `groupPolicy: "allowlist"` 并重启

**配置示例**:
```json
{
  "groupPolicy": "allowlist",
  "groupAllowlist": [
    "cidlnNrtqQ4kGskU56Qni6zTg==",
    "anotherConversationId123=="
  ],
  "requireMention": true
}
```

## 钉钉应用配置

### 创建应用

1. 登录 [钉钉开发者平台](https://open-dev.dingtalk.com)
2. 进入 **应用开发** → **企业内部开发**
3. 点击 **创建应用**
4. 添加 **机器人** 能力
5. 消息接收模式选择 **Stream 模式**

### 配置权限

应用需要以下权限：
- `qyapi_chat_manage`（企业会话管理）
- `qyapi_robot_sendmsg`（机器人发送消息）

### 获取凭证

在应用详情页面：
- **AppKey** → 这是你的 `clientId`
- **AppSecret** → 点击查看并复制，这是你的 `clientSecret`

### 发布应用

配置完成后，点击 **发布** 使应用生效。

## 故障排查

### Stream 连接失败

```
[dingtalk] Failed to start Stream
```

**可能原因**：
1. clientId 或 clientSecret 错误
2. 应用未选择 Stream 模式
3. 应用未发布

**解决方法**：
- 检查配置文件中的凭证是否正确
- 确认钉钉应用已选择 Stream 模式并发布

### 发送消息无响应

**可能原因**：
1. staffId 未添加到 allowFrom 列表
2. 群聊未 @机器人（requireMention 为 true 时）

**解决方法**：
- 查看日志获取 staffId 并添加到配置
- 在群聊中使用 @机器人名称 来触发

### 配置修改未生效

**原因**：配置修改需要重启 gateway

**解决方法**：
```bash
clawdbot gateway restart
```

## 技术细节

### 核心实现

- **Stream SDK**: `dingtalk-stream@2.1.4`
- **消息处理**: 通过 `DWClient` 建立 WebSocket 长连接
- **配置加载**: 自动调用 `cfg.loadConfig()` 获取实际配置（重要修复）
- **回复策略**: SessionWebhook (35分钟内) → REST API (兜底)

### 关键文件

| 文件 | 作用 |
|------|------|
| `src/monitor.ts` | Stream 连接 + 消息处理核心逻辑 |
| `src/api.ts` | 钉钉 REST API 封装 |
| `src/channel.ts` | ChannelPlugin 接口实现 |
| `src/accounts.ts` | 账号凭证解析 |

### 已知限制

- **Markdown 有限支持**：钉钉不支持 Markdown 表格，插件会自动转换为纯文本代码块
- **消息格式**：默认纯文本，可选 Markdown（但有语法限制）
- **媒体消息**：暂不支持文件、图片等媒体消息发送
- **钉钉限流**：20条/分钟/群，超限后10分钟限流

## 更新日志

### v0.1.0 (2026-01-26)

- ✅ 初始版本发布
- ✅ Stream 模式连接
- ✅ 私聊 + 群聊支持
- ✅ Pairing 访问控制
- ✅ 群聊白名单（groupAllowlist）
- ✅ Markdown 消息格式支持（自动转换表格为纯文本）
- ✅ 修复配置管理器对象问题（cfg.loadConfig()）

## 许可证

本插件为 Clawdbot 扩展，遵循 Clawdbot 项目的许可证。

## 贡献

发现问题或有改进建议？欢迎提交 Issue 或 Pull Request。
