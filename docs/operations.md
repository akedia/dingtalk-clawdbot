# 运维操作手册

## NPM 发布

### 发布前准备

1. **Token 类型**：NPM 现在要求使用 Granular Access Token（90 天有效期，需 2FA）
2. **创建 Token**：https://www.npmjs.com/settings/~/tokens → Generate New Token → Granular Access Token
3. **权限设置**：选择 `Read and write` 权限，Packages 选择 `@yaoyuanchao/dingtalk`

### 发布步骤

```bash
# 1. 更新版本号
# 编辑 package.json 中的 version 字段

# 2. 设置 npm token（token 过期时需要重新设置）
npm config set //registry.npmjs.org/:_authToken=npm_YOUR_TOKEN_HERE

# 3. 发布
npm publish --access public
```

### 常见问题

#### Token 过期（E404 / Not found）

```
npm error 404 Not Found - PUT https://registry.npmjs.org/@yaoyuanchao%2fdingtalk
npm notice Access token expired or revoked
```

重新生成 Granular Token 并设置。

#### 需要 OTP（EOTP）

```
npm error code EOTP
npm error This operation requires a one-time password from your authenticator
```

- 方法 A：`npm publish --otp=123456`
- 方法 B：创建"Publish"权限的 Granular Token 时勾选 "Require no 2FA for automation"

---

## Git 部署（推荐）

### 为什么用 Git 部署

| 方式 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| **Git** | 自己的服务器 | 即时部署、远程 agent 可自行修改代码 | 无版本号管理 |
| **NPM** | 发布给他人使用 | 版本号清晰、回滚方便 | 需要 token、2FA |

### 首次设置（npm → git 切换）

```bash
ssh root@172.20.90.45 "sudo -u clawd bash -c '
  cd /home/clawd/.openclaw/extensions
  [ -d dingtalk ] && mv dingtalk dingtalk.npm-backup
  git clone https://github.com/akedia/dingtalk-clawdbot.git dingtalk
  cd dingtalk && npm install --omit=dev
'"

# 重启 gateway
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"

# 验证成功后删除备份
ssh root@172.20.90.45 "rm -rf /home/clawd/.openclaw/extensions/dingtalk.npm-backup"
```

### 日常更新（git pull）

```bash
# 本地：推送到 GitHub
git push origin master

# 远端：拉取 + 重启
ssh root@172.20.90.45 "sudo -u clawd bash -c '
  cd /home/clawd/.openclaw/extensions/dingtalk && git pull
' && sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"
```

### 远程 Agent 自行修改代码

Git 部署的优势是远程 agent 可以直接修改代码并提交：

```bash
cd /home/clawd/.openclaw/extensions/dingtalk
git add -A && git commit -m "fix: xxx" && git push origin master

# 重启生效
openclaw gateway restart
```

### 注意事项

1. **不要混用**：切换到 git 后，不要再用 `openclaw plugins update dingtalk`（会覆盖为 npm 版本）
2. **备份目录**：切换前如果保留了 `.npm-backup`，记得删除，否则会报重复插件警告
3. **依赖更新**：如果 `package.json` 有变化，git pull 后需要 `npm install --omit=dev`

---

## 故障排查

### 查看 Gateway 日志

```bash
# 实时日志（systemd journal）
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  journalctl --user -u openclaw-gateway.service -f"

# 最近 N 条
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  journalctl --user -u openclaw-gateway.service -n 50 --no-pager"

# 结构化 JSON 日志（每行一条，便于 grep / 过滤）
ssh root@172.20.90.45 "tail -300 /tmp/openclaw/openclaw-\$(date +%Y-%m-%d).log | python3 -c '
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        msg = str(obj.get(\"0\", \"\"))
        if msg.startswith(\"{\") or not msg: continue
        time_str = obj.get(\"time\", \"\")[:19]
        level = obj.get(\"_meta\", {}).get(\"logLevelName\", \"\")
        if len(msg) > 300: msg = msg[:300] + \"...\"
        print(f\"{time_str} [{level:5s}] {msg}\")
    except: pass
' | tail -80"
```

### Gateway 状态 / 诊断

```bash
# 状态
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway status"

# 诊断（不修改）
ssh root@172.20.90.45 "sudo -u clawd openclaw doctor"

# 自动修复（会创建 openclaw.json.bak 备份）
ssh root@172.20.90.45 "sudo -u clawd openclaw doctor --fix"
```

⚠️ `doctor --fix` 可能向 channel 配置注入平台级键（如 `allowFrom`）。插件的 Zod schema 已改为 `.passthrough()` 兼容，但升级后还是要检查 doctor 输出修改了哪些键。

### 重启 Gateway

```bash
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"
```

### Session 清理

```bash
ssh root@172.20.90.45 "sudo -u clawd openclaw sessions cleanup"
```

### 查看已安装插件

```bash
ssh root@172.20.90.45 "ls -la /home/clawd/.openclaw/extensions/"
```

---

## OpenClaw 升级流程

### 标准步骤

```bash
# 1. 备份配置（doctor 也会创建 .bak，但显式备份更安全）
ssh root@172.20.90.45 "sudo -u clawd cp /home/clawd/.openclaw/openclaw.json /home/clawd/.openclaw/openclaw.json.pre-<version>.bak"

# 2. 查看目标版本的 CHANGELOG（尤其 Breaking）
cd /tmp && npm pack openclaw@<version> >/dev/null && tar -xzf openclaw-*.tgz -C /tmp/oc-changelog package/CHANGELOG.md
grep -n '^### Breaking' /tmp/oc-changelog/package/CHANGELOG.md

# 3. 安装新版本
ssh root@172.20.90.45 "npm install -g openclaw@<version>"
ssh root@172.20.90.45 "openclaw --version"

# 4. 配置迁移（doctor 会创建 .bak 备份；用 doctor 先看、再决定是否 --fix）
ssh root@172.20.90.45 "sudo -u clawd openclaw doctor"

# 5. 检查 systemd entrypoint 是否需要更新（新版入口变化过）
ssh root@172.20.90.45 "cat /home/clawd/.config/systemd/user/openclaw-gateway.service | grep ExecStart"
ssh root@172.20.90.45 "ls /usr/lib/node_modules/openclaw/dist/ | head"

# 6. 重启 gateway
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"

# 7. 验证 channel 连接
ssh root@172.20.90.45 "tail -200 /tmp/openclaw/openclaw-\$(date +%Y-%m-%d).log | grep -E 'Stream connected|listening|failed'"
```

### 回滚

```bash
# 配置回滚
ssh root@172.20.90.45 "sudo -u clawd cp /home/clawd/.openclaw/openclaw.json.pre-<version>.bak /home/clawd/.openclaw/openclaw.json"

# CLI 版本回滚
ssh root@172.20.90.45 "npm install -g openclaw@<previous-version>"

# 重启
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"
```

---

## 已知问题

### SDK 报错 `Cannot read properties of undefined (reading 'some')`

**症状**：
- Agent 收到请求后立即返回错误消息给用户
- 日志显示 agent 只运行了几毫秒就结束
- 可能伴随 "Removed orphaned user message" 警告

**根因**（2026-01-31 确认）：
- `listActions` 返回的数组中缺少 `sendAttachment`
- SDK 在构建 message tool schema 时依赖 `listActions` 返回的 action 列表
- 如果 action 在 `MESSAGE_ACTION_TARGET_MODE` 中定义但不在 `listActions` 返回值中，SDK 内部会出错

**解决**：确保 `listActions` 返回所有支持的 actions

```typescript
listActions({ cfg }: { cfg: any }) {
  return ['send', 'sendAttachment'];
}
```

### 插件 `plugins update` 破坏性 + 超时

**不要用** `openclaw plugins update dingtalk`：
- 非原子操作：失败时旧版本可能已被删除，插件完全不可用
- 内部 `npm install` 超时 5 分钟，冷启动（无缓存）不够（~28 分钟）
- 失败错误信息常被吞掉
- 当前服务器走 Git 部署，用 `openclaw plugins update` 会覆盖回 npm 版本

正确做法见上面的 [Git 部署](#git-部署推荐) 章节。

---
**最后更新**: 2026-04-24
