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
| v1.7.11 | Queue lane 路由：`/btw` 与 `/stop` 走独立 lane，避免相互阻塞 |
| v1.7.10 | Cron/proactive 发送改走 `deliverReply`，保留 persona |
| v1.7.8 | Group 自动 `@mention` 发送者、支持 `<at:staffId>` 显式 @ |
| v1.7.6 | 内容级 dedup：钉钉重投同一消息但换了 msgId 的场景也能挡住 |
| v1.7.5 | 恢复 `dispatcher.waitForIdle()` 以兼容 OpenClaw 2026.4+ |
| v1.7.4 | 业务级 `msgId` dedup，挡住重复回复；typing indicator 撤回时机修复 |
| v1.7.0~ | Per-group sender allowFrom 过滤、Heartbeat 超时调优 |
| v1.5.0 | **OpenClaw 兼容**：新增 `openclaw.plugin.json`，支持 ClawdBot → OpenClaw 无缝迁移 |
| v1.4.20 | 消息聚合：同一用户短时间内的多条消息合并处理，解决链接卡片分割问题 |
| v1.4.x | 媒体消息、长文本文件发送、sendAttachment、listActions、markdown 默认 |
| v1.3.0 | 完整 SDK Pipeline、媒体支持 |
| v1.2.0 | NPM 官方发布 |

完整变更见 [CHANGELOG.md](./CHANGELOG.md) 与 `git log`。

---

**最后更新**: 2026-04-24 (v1.7.11)
