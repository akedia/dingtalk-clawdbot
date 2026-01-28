# 配置兼容性说明

## v0.1.0 → v1.2.0 配置兼容性

### 完全兼容的配置项

以下配置项在 v1.2.0 中**完全兼容**，无需修改：

| 配置项 | v0.1.0 | v1.2.0 | 说明 |
|-------|--------|--------|------|
| `enabled` | ✅ | ✅ | 是否启用频道 |
| `clientId` | ✅ | ✅ | 应用 AppKey |
| `clientSecret` | ✅ | ✅ | 应用 AppSecret |
| `robotCode` | ✅ | ✅ | 机器人代码 |
| `dm.policy` | ✅ | ✅ | 私聊策略 |
| `dm.allowFrom` | ✅ | ✅ | 私聊白名单 |
| `groupPolicy` | ✅ | ✅ | 群聊策略 |
| `groupAllowlist` | ✅ | ✅ | 群聊白名单 |
| `requireMention` | ✅ | ✅ | 群聊需要 @mention |
| `textChunkLimit` | ✅ | ✅ | 文本分块大小 |

### messageFormat 配置变化

**v0.1.0 支持的值**:
- `"text"` - 纯文本
- `"markdown"` - Markdown 格式
- `"richtext"` - 富文本（实际上等同于 markdown）

**v1.2.0 支持的值**:
- `"text"` - 纯文本（推荐）
- `"markdown"` - Markdown 格式
- `"richtext"` - **保留支持**，作为 `markdown` 的别名（deprecated）

#### 兼容性状态

✅ **完全兼容** - v0.1.0 的所有配置值在 v1.2.0 中都有效

```json
{
  "messageFormat": "richtext"  // ✅ v1.2.0 仍然支持
}
```

#### 建议

虽然 `richtext` 仍被支持，但建议在升级后改用 `markdown`：

```json
{
  "messageFormat": "markdown"  // 推荐使用
}
```

或者使用默认的 `text` 格式（支持表格）：

```json
{
  "messageFormat": "text"  // 最推荐
}
```

### 新增配置项（可选）

v1.2.0 新增以下可选配置项，如未配置会使用默认值：

| 配置项 | 默认值 | 说明 |
|-------|--------|------|
| `dm.enabled` | `true` | 是否启用私聊（新增，默认启用） |

## 配置验证变化

### v0.1.0: JSON Schema

旧版本使用 JSON Schema 进行配置验证，错误提示较为模糊：

```
Error: Invalid configuration
```

### v1.2.0: Zod Schema

新版本使用 Zod 进行类型安全验证，提供详细错误信息：

```
DingTalk config validation failed:
  - clientId: Client ID (AppKey) is required
  - dm.policy: Invalid enum value. Expected 'disabled' | 'pairing' | 'allowlist' | 'open', received 'invalid'
```

### 验证时机

v1.2.0 在以下时机进行配置验证：

1. **插件加载时** - 启动 gateway 时验证
2. **配置向导** - `clawdbot onboard --channel dingtalk` 时
3. **运行时** - 调用 `resolveDingTalkAccount()` 时

## 环境变量兼容性

### 完全兼容

以下环境变量在 v0.1.0 和 v1.2.0 中**完全一致**：

```bash
DINGTALK_CLIENT_ID=dingXXXXXXXXXXXXXXXX
DINGTALK_CLIENT_SECRET=your-secret-here
DINGTALK_ROBOT_CODE=dingXXXXXXXXXXXXXXXX  # 可选
```

**优先级**: 环境变量 > 配置文件

## 代码兼容性

### API 不变

以下核心 API 在 v1.2.0 中保持不变：

- `resolveDingTalkAccount()`
- `getDingTalkAccessToken()`
- `sendDingTalkRestMessage()`
- `startDingTalkMonitor()`

### 新增 API

v1.2.0 新增以下 API：

- `probeDingTalk()` - 健康检查
- `onboardDingTalk()` - 配置向导
- `validateDingTalkConfig()` - 配置验证
- `safeValidateDingTalkConfig()` - 安全的配置验证

## 升级检查清单

在升级到 v1.2.0 之前，请确认：

- [ ] 已备份 `~/.clawdbot/clawdbot.json`
- [ ] `messageFormat` 使用的是 `text`、`markdown` 或 `richtext`（不是其他值）
- [ ] `dm.policy` 是有效值（disabled/pairing/allowlist/open）
- [ ] `groupPolicy` 是有效值（disabled/allowlist/open）
- [ ] `clientId` 和 `clientSecret` 已配置且有效

## 已知问题

### 问题 1: `richtext` 虽然支持，但被标记为 deprecated

**影响**: 无实际影响，仅在文档和类型提示中标记为过时

**建议**: 在方便时改为 `markdown` 或 `text`

### 问题 2: 配置验证更严格

**影响**: 一些之前能通过的"宽松"配置现在会被拒绝

**示例**:
```json
{
  "dm": {
    "policy": "invalid-value"  // v0.1.0 可能忽略，v1.2.0 会报错
  }
}
```

**解决**: 修正为有效值

## 配置迁移示例

### 示例 1: 标准配置（无需修改）

```json
// v0.1.0
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingXXXXX",
      "clientSecret": "secret",
      "dm": {
        "policy": "pairing",
        "allowFrom": ["050914185922786044"]
      },
      "groupPolicy": "allowlist",
      "groupAllowlist": ["cidXXXXX"],
      "requireMention": true,
      "messageFormat": "text"
    }
  }
}

// v1.2.0 - 完全相同，无需修改 ✅
```

### 示例 2: 使用 richtext（建议修改）

```json
// v0.1.0
{
  "messageFormat": "richtext"
}

// v1.2.0 - 可以继续使用，但建议改为：
{
  "messageFormat": "markdown"  // 推荐
  // 或
  "messageFormat": "text"      // 更推荐
}
```

### 示例 3: 环境变量配置（无需修改）

```bash
# v0.1.0
export DINGTALK_CLIENT_ID=dingXXXXX
export DINGTALK_CLIENT_SECRET=secret

# v1.2.0 - 完全相同 ✅
export DINGTALK_CLIENT_ID=dingXXXXX
export DINGTALK_CLIENT_SECRET=secret
```

## 测试配置兼容性

升级后运行以下命令验证配置：

```bash
# 1. 验证配置文件格式
clawdbot doctor

# 2. 检查插件加载
clawdbot plugins list | grep dingtalk

# 3. 测试连接（需要 v1.2.0）
clawdbot status --deep

# 4. 查看详细日志
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep dingtalk
```

## 总结

| 方面 | 兼容性状态 |
|------|-----------|
| **配置格式** | ✅ 完全兼容 |
| **环境变量** | ✅ 完全兼容 |
| **核心功能** | ✅ 完全兼容 |
| **messageFormat** | ✅ richtext 仍支持（但 deprecated） |
| **API 接口** | ✅ 保持不变 + 新增 |
| **验证逻辑** | ⚠️ 更严格（但兼容合法配置） |

**结论**: v1.2.0 对 v0.1.0 提供**完全的配置兼容性**，用户可以放心升级。

---

**最后更新**: 2026-01-28
**版本**: 1.2.0
