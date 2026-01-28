# 升级指南 - v0.1.0 → v1.2.0

## 概述

如果你之前通过手动复制源码方式安装了 DingTalk 插件 v0.1.0，本文档将指导你升级到官方 NPM 版本 v1.2.0。

**核心结论**: v1.2.0 对 v0.1.0 **100% 配置兼容**，所有配置项无需修改即可使用。

## 升级前准备

### 检查当前版本

```bash
clawdbot plugins list | grep -A 2 dingtalk
```

如果显示的 Source 是本地路径（如 `~/.clawdbot/extensions/dingtalk/index.ts`），说明你使用的是手动安装版本，需要升级。

### 版本对比

| 特性 | v0.1.0 (手动安装) | v1.2.0 (NPM) |
|------|------------------|-------------|
| 安装方式 | 手动复制代码 | NPM 官方安装 |
| 配置验证 | JSON Schema | Zod (类型安全，错误提示更详细) |
| 配置向导 | 无 | 交互式 (`clawdbot onboard --channel dingtalk`) |
| 健康检查 | 无 | 延迟监控 (`clawdbot status --deep`) |
| 升级方式 | 手动替换文件 | `clawdbot plugins update` |

## 升级步骤（4 步）

### 步骤 1: 备份配置

```bash
cp ~/.clawdbot/clawdbot.json ~/.clawdbot/clawdbot.json.backup-$(date +%Y%m%d)
```

### 步骤 2: 停止 Gateway

```bash
clawdbot gateway stop

# 或者如果使用 systemd
sudo systemctl stop clawdbot-gateway
```

### 步骤 3: 删除旧版本 + 安装新版本

```bash
rm -rf ~/.clawdbot/extensions/dingtalk
clawdbot plugins install @yaoyuanchao/dingtalk
```

预期输出：
```
Downloading @yaoyuanchao/dingtalk…
Extracting /tmp/clawdbot-npm-pack-XXXXXX/yaoyuanchao-dingtalk-1.2.0.tgz…
Installing to ~/.clawdbot/extensions/dingtalk…
Installing plugin dependencies…
Installed plugin: dingtalk
```

> **说明**: `clawdbot plugins install` 只会注册插件元数据（`plugins.entries` 和 `plugins.installs`），不会修改 `channels.dingtalk` 用户配置。你的凭证、白名单等配置会原样保留。

### 步骤 4: 验证并启动

```bash
# 检查配置是否完整
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk'

# 验证配置格式
clawdbot doctor

# 检查插件状态
clawdbot plugins list | grep dingtalk
# 预期: │ DingTalk │ dingtalk │ loaded │ ... │ 1.2.0 │

# 启动 Gateway
clawdbot gateway
# 或: sudo systemctl start clawdbot-gateway

# 查看日志验证连接
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep dingtalk
```

预期日志：
```
[dingtalk] Starting Stream connection...
[dingtalk:default] Starting Stream...
[dingtalk:default] Stream connected
```

## 配置兼容性

### 所有配置项 100% 兼容

| 配置项 | v0.1.0 | v1.2.0 | 说明 |
|-------|--------|--------|------|
| `enabled` | 支持 | 支持 | 是否启用频道 |
| `clientId` | 支持 | 支持 | 应用 AppKey |
| `clientSecret` | 支持 | 支持 | 应用 AppSecret |
| `robotCode` | 支持 | 支持 | 机器人代码（可选） |
| `dm.policy` | 支持 | 支持 | 私聊策略 (disabled/pairing/allowlist/open) |
| `dm.allowFrom` | 支持 | 支持 | 私聊白名单 (staffId 数组) |
| `groupPolicy` | 支持 | 支持 | 群聊策略 (disabled/allowlist/open) |
| `groupAllowlist` | 支持 | 支持 | 群聊白名单 (conversationId 数组) |
| `requireMention` | 支持 | 支持 | 群聊需要 @mention |
| `messageFormat` | 支持 | 支持 | 消息格式 (text/markdown/richtext) |
| `textChunkLimit` | 支持 | 支持 | 文本分块大小 |

### messageFormat 说明

| 值 | v1.2.0 状态 | 说明 |
|-----|-----------|------|
| `"text"` | 推荐 | 纯文本，支持表格 |
| `"markdown"` | 支持 | DingTalk Markdown（表格受限） |
| `"richtext"` | 支持 (deprecated) | 作为 `markdown` 的别名，建议改为 `markdown` |

如果你的旧配置使用 `"richtext"`，**无需修改**，v1.2.0 会自动兼容。

### 环境变量兼容性

以下环境变量在两个版本中完全一致：

```bash
DINGTALK_CLIENT_ID=dingXXXXXXXXXXXXXXXX
DINGTALK_CLIENT_SECRET=your-secret-here
DINGTALK_ROBOT_CODE=dingXXXXXXXXXXXXXXXX  # 可选
```

优先级: 环境变量 > 配置文件

### 配置验证变化

v1.2.0 使用 Zod 替代 JSON Schema，验证**更严格**：

- 未知字段会被拒绝（`.strict()` 模式）
- 枚举值必须精确匹配（如 `dm.policy` 不接受拼写错误）
- 错误提示更详细，会指出具体字段和原因

```
# v1.2.0 错误提示示例
DingTalk config validation failed:
  - clientId: Client ID (AppKey) is required
  - dm.policy: Invalid enum value. Expected 'disabled' | 'pairing' | 'allowlist' | 'open'
```

**注意**: 只要 v0.1.0 的配置值都是合法的，就不会有问题。

## 故障排查

### 问题 1: 权限错误

**错误**: `EACCES: permission denied, mkdir '/home/xxx/.clawdbot/extensions/dingtalk'`

**原因**: extensions 目录权限不正确（可能之前用 root 安装过）

**解决**:
```bash
sudo chown -R $USER:$USER ~/.clawdbot/extensions
```

### 问题 2: 配置验证失败

**错误**: `plugins.entries.dingtalk: plugin not found: dingtalk`

**原因**: 配置文件中有旧的插件引用，但插件代码不存在

**解决**:
```bash
# 确认插件已安装
ls ~/.clawdbot/extensions/dingtalk/

# 如果目录不存在，重新安装
clawdbot plugins install @yaoyuanchao/dingtalk

# 验证
clawdbot doctor
```

### 问题 3: Stream 连接失败

**错误**: 日志中显示 `Failed to start Stream`

**原因**: clientId 或 clientSecret 配置错误，或钉钉应用未启用 Stream 模式

**解决**:
```bash
# 验证配置
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk'

# 运行配置向导重新设置
clawdbot onboard --channel dingtalk
```

### 问题 4: channels.dingtalk 配置丢失

**原因**: 安装过程中配置被意外清除

**解决**:
```bash
# 从备份恢复
cp ~/.clawdbot/clawdbot.json.backup-YYYYMMDD ~/.clawdbot/clawdbot.json

# 重新执行升级步骤 3
```

## 回滚

如果升级后遇到问题，可以回滚：

```bash
# 1. 停止 gateway
clawdbot gateway stop

# 2. 删除新版本
rm -rf ~/.clawdbot/extensions/dingtalk

# 3. 恢复备份的配置
cp ~/.clawdbot/clawdbot.json.backup-YYYYMMDD ~/.clawdbot/clawdbot.json

# 4. 重新安装旧版本（从备份目录复制）
# 5. 启动 gateway
clawdbot gateway
```

## 升级后新功能

### 交互式配置向导

```bash
clawdbot onboard --channel dingtalk
```

引导你完成: 输入凭证 → 自动测试连接 → 选择访问策略 → 自动保存配置

### 健康检查

```bash
clawdbot status --deep
# 输出: │ DingTalk │ ON │ OK │ latency: 245ms │
```

## 常见问题 (FAQ)

**Q: 升级后配置会丢失吗？**
A: 不会。`clawdbot plugins install` 不修改 `channels.dingtalk` 配置，且升级前有备份。

**Q: 旧版本的 staffId 白名单会保留吗？**
A: 会保留，配置格式完全兼容。

**Q: 升级需要重新配置钉钉应用吗？**
A: 不需要，钉钉应用端无需任何修改。

**Q: 能否保留旧版本和新版本共存？**
A: 不建议，会导致插件 ID 冲突。应该完全替换。

**Q: 如果配置使用 `messageFormat: "richtext"`？**
A: 完全兼容，v1.2.0 继续支持 richtext（作为 markdown 的别名）。

## 下次升级

从 v1.2.0 开始，升级只需：

```bash
clawdbot gateway stop
clawdbot plugins update @yaoyuanchao/dingtalk
clawdbot gateway
```

配置会自动保留，无需手动备份。

## 通知老用户（模板）

升级文档准备好后，可以通过钉钉/微信/邮件发送以下通知：

```
【DingTalk 插件升级通知 v1.2.0】

插件已发布到 NPM，支持官方安装！

升级方法（4 步）：

1. 备份：cp ~/.clawdbot/clawdbot.json ~/.clawdbot/clawdbot.json.backup
2. 停止：clawdbot gateway stop
3. 替换：rm -rf ~/.clawdbot/extensions/dingtalk && clawdbot plugins install @yaoyuanchao/dingtalk
4. 启动：clawdbot gateway

配置完全兼容，staffId/群聊白名单自动保留，无需改配置。

新增功能：配置向导、健康检查、详细错误提示
详细文档：https://github.com/akedia/dingtalk-clawdbot/blob/main/UPGRADE.md
```

## 获取帮助

1. 查看日志: `tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log`
2. 运行诊断: `clawdbot doctor`
3. GitHub Issues: https://github.com/akedia/dingtalk-clawdbot/issues

---

**最后更新**: 2026-01-28
