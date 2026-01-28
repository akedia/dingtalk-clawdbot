# 升级指南

## 快速升级（v1.2.0+ → v1.3.5）

已经通过 NPM 安装的用户，一行命令升级：

```bash
clawdbot plugins update dingtalk
clawdbot gateway restart
```

配置完全兼容，无需修改。升级内容见 [CHANGELOG.md](./CHANGELOG.md)。

### 远端一键升级

```bash
ssh root@<your-server> "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  bash -c 'clawdbot plugins update dingtalk && clawdbot gateway restart'"
```

> **注意**: `su - clawd` 不建立 systemd 用户会话，必须注入 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS` 环境变量。

---

## 首次安装（全新部署）

```bash
clawdbot plugins install @yaoyuanchao/dingtalk
clawdbot onboard --channel dingtalk   # 交互式配置向导
clawdbot gateway restart
```

---

## 从 v0.1.0（手动安装）迁移到 v1.3.5

### 概述

v0.1.0 是通过手动复制源码到 `~/.clawdbot/extensions/dingtalk/` 安装的。v1.3.5 通过 NPM 官方安装。**配置 100% 兼容**，所有配置项无需修改。

### 版本对比

| 特性 | v0.1.0 (手动) | v1.3.5 (NPM) |
|------|--------------|--------------|
| 安装方式 | 手动复制代码 | `clawdbot plugins install` |
| 升级方式 | 手动替换文件 | `clawdbot plugins update` |
| 配置验证 | JSON Schema | Zod (类型安全) |
| 配置向导 | 无 | `clawdbot onboard --channel dingtalk` |
| 健康检查 | 无 | `clawdbot status --deep` |
| 消息可靠性 | 无 webhook 校验 | errcode 校验 + REST API 自动降级 |
| Stream ACK | AI 处理后 ACK | 收到即 ACK（防 60s 超时重试） |
| 媒体支持 | 仅文本/图片 | 图片/语音/视频/文件 |
| SDK 管道 | 仅 buffered dispatcher | 自动检测完整 SDK pipeline |
| Markdown | text/markdown | text/markdown/auto（智能检测） |

### 迁移步骤

#### 1. 备份

```bash
cp ~/.clawdbot/clawdbot.json ~/.clawdbot/clawdbot.json.backup-$(date +%Y%m%d)
```

#### 2. 停止 Gateway

```bash
clawdbot gateway stop
```

#### 3. 安装新版本（覆盖旧文件）

```bash
clawdbot plugins install @yaoyuanchao/dingtalk
```

> 如果提示 `plugin already exists`，先备份再删除旧目录：
> ```bash
> cp -r ~/.clawdbot/extensions/dingtalk ~/.clawdbot/extensions/dingtalk.bak
> rm -rf ~/.clawdbot/extensions/dingtalk
> clawdbot plugins install @yaoyuanchao/dingtalk
> ```
>
> **重要**: 删除旧目录后必须立即安装新版本再启动 gateway，否则配置验证会失败（配置引用了已删除的插件）。

#### 4. 验证并启动

```bash
# 检查插件已安装
clawdbot plugins list | grep dingtalk

# 检查配置完整
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk'

# 启动
clawdbot gateway restart

# 查看日志
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep dingtalk
```

预期日志：
```
[dingtalk] Starting Stream connection...
[dingtalk:default] Stream connected
[dingtalk] Stream connection started successfully
```

### 配置兼容性

所有 v0.1.0 配置项在 v1.3.5 中完全兼容：

| 配置项 | 说明 |
|-------|------|
| `clientId` / `clientSecret` | 应用凭证，不变 |
| `robotCode` | 机器人代码（可选），不变 |
| `dm.policy` | 私聊策略 (disabled/pairing/allowlist/open)，不变 |
| `dm.allowFrom` | 私聊白名单 (staffId 数组)，不变 |
| `groupPolicy` | 群聊策略 (disabled/allowlist/open)，不变 |
| `groupAllowlist` | 群聊白名单 (conversationId 数组)，不变 |
| `requireMention` | 群聊需要 @mention，不变 |
| `messageFormat` | `"text"` / `"markdown"` / `"richtext"` 均兼容 |

v1.3.5 新增可选配置（不需要手动添加，有默认值）：

| 配置项 | 默认值 | 说明 |
|-------|--------|------|
| `showThinking` | `false` | 收到消息后发送 "正在思考..." 提示 |
| `messageFormat: "auto"` | — | 智能检测回复内容是否含 markdown 语法 |

### 环境变量

完全兼容，优先级: 环境变量 > 配置文件

```bash
DINGTALK_CLIENT_ID=dingXXXXXXXXXXXXXXXX
DINGTALK_CLIENT_SECRET=your-secret-here
DINGTALK_ROBOT_CODE=dingXXXXXXXXXXXXXXXX  # 可选
```

---

## 故障排查

### 配置验证失败: `plugin not found: dingtalk`

**原因**: 删除了旧插件目录但未安装新版本，配置仍引用 dingtalk 插件。

**解决**: 安装新版本即可。
```bash
clawdbot plugins install @yaoyuanchao/dingtalk
```

### 权限错误: EACCES

```bash
sudo chown -R $USER:$USER ~/.clawdbot/extensions
```

### Stream 连接失败

```bash
# 检查凭证
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk | {clientId, clientSecret}'

# 重新配置
clawdbot onboard --channel dingtalk
```

### 消息发送后不可见

检查日志中 `SessionWebhook send OK (errcode=0)` 是否出现。v1.3.5 会在 webhook 返回非零 errcode 时自动降级到 REST API。

---

## 禁止的做法

- **不要** `rm -rf extensions/dingtalk` 后不立即重装——会导致配置验证失败
- **不要** `kill` / `pkill` 管理 gateway——使用 `clawdbot gateway stop/restart`
- **不要** 手动 `npm pack` + `tar` 更新——使用 `clawdbot plugins update`

---

## 回滚

```bash
clawdbot gateway stop
rm -rf ~/.clawdbot/extensions/dingtalk
cp ~/.clawdbot/clawdbot.json.backup-YYYYMMDD ~/.clawdbot/clawdbot.json
# 重新安装旧版本或从备份恢复
clawdbot gateway
```

---

**最后更新**: 2026-01-28 (v1.3.5)
