# 升级指南

## 快速升级（推荐）

从 v1.4.10 开始，官方命令可以正常工作：

```bash
# 升级插件
clawdbot plugins update dingtalk

# 重启 gateway
clawdbot gateway restart
```

### 远端服务器升级

```bash
# 升级（需要 systemd 环境变量）
ssh root@<your-server> "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  bash -c 'clawdbot plugins update dingtalk && clawdbot gateway restart'"
```

> **注意**: `su - clawd` 不建立 systemd 用户会话，必须注入环境变量。

---

## 首次安装

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
cd ~/.clawdbot/extensions
rm -rf dingtalk
npm pack @yaoyuanchao/dingtalk
tar -xzf yaoyuanchao-dingtalk-*.tgz
mv package dingtalk
rm yaoyuanchao-dingtalk-*.tgz
cd dingtalk && npm install --omit=dev
clawdbot gateway restart
```

### 配置验证失败: `plugin not found: dingtalk`

删除了插件目录但未重新安装：
```bash
clawdbot plugins install @yaoyuanchao/dingtalk
```

### Stream 连接失败

```bash
# 检查凭证
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk | {clientId, clientSecret}'

# 重新配置
clawdbot onboard --channel dingtalk
```

---

## 版本历史

| 版本 | 关键变更 |
|------|---------|
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

**最后更新**: 2026-01-31 (v1.4.18)
