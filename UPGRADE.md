# 升级指南

## OpenClaw 兼容性 (v1.5.0+)

本插件同时兼容 **ClawdBot** 和 **OpenClaw**（ClawdBot 的新名称）。

### 从 ClawdBot 迁移到 OpenClaw

插件可以**无缝迁移**，无需修改代码。迁移步骤：

```bash
# 1. 升级到 OpenClaw
npm install -g openclaw@latest

# 2. 运行配置迁移
openclaw doctor --fix

# 3. 确保插件目录有 openclaw.plugin.json（v1.5.0+ 已包含）
# 如果没有，手动复制：
cp ~/.openclaw/extensions/dingtalk/clawdbot.plugin.json \
   ~/.openclaw/extensions/dingtalk/openclaw.plugin.json

# 4. 重启服务
openclaw gateway restart
```

> **注意**: v1.5.0 起插件同时包含 `clawdbot.plugin.json` 和 `openclaw.plugin.json`，无需手动操作。

---

## 快速升级（推荐）

### OpenClaw 用户

```bash
openclaw plugins update dingtalk
openclaw gateway restart
```

### ClawdBot 用户（旧版）

从 v1.4.10 开始，官方命令可以正常工作：

```bash
clawdbot plugins update dingtalk
clawdbot gateway restart
```

### 远端服务器升级

```bash
# OpenClaw
ssh root@<your-server> "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  bash -c 'openclaw plugins update dingtalk && openclaw gateway restart'"

# ClawdBot (旧版)
ssh root@<your-server> "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  bash -c 'clawdbot plugins update dingtalk && clawdbot gateway restart'"
```

> **注意**: `su - clawd` 不建立 systemd 用户会话，必须注入环境变量。

---

## 首次安装

### OpenClaw

```bash
openclaw plugins install @yaoyuanchao/dingtalk
openclaw onboard --channel dingtalk   # 交互式配置向导
openclaw gateway restart
```

### ClawdBot (旧版)

```bash
clawdbot plugins install @yaoyuanchao/dingtalk
clawdbot onboard --channel dingtalk   # 交互式配置向导
clawdbot gateway restart
```

---

## 故障排查

### 升级失败: `npm install failed`

如果遇到超时或网络问题，可手动安装：

```bash
# OpenClaw
cd ~/.openclaw/extensions
rm -rf dingtalk
npm pack @yaoyuanchao/dingtalk
tar -xzf yaoyuanchao-dingtalk-*.tgz
mv package dingtalk
rm yaoyuanchao-dingtalk-*.tgz
cd dingtalk && npm install --omit=dev
openclaw gateway restart

# ClawdBot (旧版) - 将 ~/.openclaw 替换为 ~/.clawdbot
```

### 配置验证失败: `plugin not found: dingtalk`

删除了插件目录但未重新安装：
```bash
openclaw plugins install @yaoyuanchao/dingtalk
# 或 clawdbot plugins install @yaoyuanchao/dingtalk
```

### OpenClaw 迁移后: `plugin manifest not found: openclaw.plugin.json`

旧版本插件没有 `openclaw.plugin.json`，手动复制即可：
```bash
cp ~/.openclaw/extensions/dingtalk/clawdbot.plugin.json \
   ~/.openclaw/extensions/dingtalk/openclaw.plugin.json
openclaw gateway restart
```

### Stream 连接失败

```bash
# 检查凭证 (OpenClaw)
cat ~/.openclaw/openclaw.json | jq '.channels.dingtalk | {clientId, clientSecret}'

# 检查凭证 (ClawdBot)
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk | {clientId, clientSecret}'

# 重新配置
openclaw onboard --channel dingtalk
# 或 clawdbot onboard --channel dingtalk
```

---

## 版本历史

| 版本 | 关键变更 |
|------|---------|
| v1.5.0 | **OpenClaw 兼容**：新增 `openclaw.plugin.json`，支持 ClawdBot → OpenClaw 无缝迁移 |
| v1.4.20 | 消息聚合：同一用户短时间内的多条消息合并处理，解决链接卡片分割问题 |
| v1.4.19 | 支持链接卡片消息（link msgtype），用户分享的链接可被正确解析 |
| v1.4.18 | 修复 sendAttachment 返回格式，避免 SDK 报错；默认阈值改为 8000 |
| v1.4.17 | 添加 listActions，让 SDK 告知 agent 支持 sendAttachment |
| v1.4.16 | 支持 sendAttachment action，agent 可主动发送文件 |
| v1.4.15 | 新增 outbound.sendFile 能力，支持主动发送文件 |
| v1.4.14 | message 工具默认使用 markdown 格式发送 |
| v1.4.13 | message 工具支持 longTextMode=file |
| v1.4.12 | 修复文件上传 API (切换到 oapi 端点) |
| v1.4.11 | 新增 longTextMode=file 配置，支持长文本转.md文件发送 |
| v1.4.10 | 移除 peerDependencies，官方升级命令可用 |
| v1.4.9 | zod v4 兼容性修复 |
| v1.4.7 | chatRecord 消息图片下载 |
| v1.3.0 | 完整 SDK Pipeline、媒体支持 |
| v1.2.0 | NPM 官方发布 |

---

**最后更新**: 2026-01-31 (v1.4.20)
