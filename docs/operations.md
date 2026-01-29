# 运维操作手册

## 插件更新

### 官方推荐方法

根据 [Clawdbot 官方文档](https://docs.molt.bot/cli/plugins.md)：

```bash
# 更新单个插件
clawdbot plugins update <plugin-id>

# 更新所有插件
clawdbot plugins update --all

# 预览更新（不实际执行）
clawdbot plugins update <plugin-id> --dry-run
```

**重要限制**：更新功能仅适用于通过 npm 安装的插件（记录在 `plugins.installs` 中）。

### 远端服务器更新命令

由于 `su - clawd` 不会建立 systemd 用户会话，必须注入环境变量：

```bash
# 正确方式（注入 systemd 环境变量）
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  bash -c 'clawdbot plugins update dingtalk && clawdbot gateway restart'"
```

### 已知问题与解决方案

#### 问题 1：`clawdbot plugins update` 失败但无明确错误

**症状**：
```
Failed to update dingtalk: npm install failed:
```
版本号没有更新（如仍显示 1.4.0 而非 1.4.1）。

**原因**：
- npm 缓存问题
- 依赖安装失败但错误信息被吞掉
- 插件目录权限问题

**解决方案**：手动重新安装插件

```bash
# 1. 删除旧插件目录
ssh root@172.20.90.45 "rm -rf /home/clawd/.clawdbot/extensions/dingtalk"

# 2. 手动下载并安装
ssh root@172.20.90.45 "sudo -u clawd bash -c '\
  cd /home/clawd/.clawdbot/extensions && \
  npm pack @yaoyuanchao/dingtalk && \
  tar -xzf yaoyuanchao-dingtalk-*.tgz && \
  mv package dingtalk && \
  rm yaoyuanchao-dingtalk-*.tgz'"

# 3. 安装依赖
ssh root@172.20.90.45 "cd /home/clawd/.clawdbot/extensions/dingtalk && sudo -u clawd npm install"

# 4. 重启 gateway
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  clawdbot gateway restart"
```

#### 问题 2：插件加载失败 - Cannot find module

**症状**：
```
[gateway] [plugins] dingtalk failed to load: Error: Cannot find module 'zod'
```

**原因**：`clawdbot plugins update` 没有正确安装插件依赖。

**解决方案**：手动安装依赖

```bash
ssh root@172.20.90.45 "cd /home/clawd/.clawdbot/extensions/dingtalk && sudo -u clawd npm install"
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  clawdbot gateway restart"
```

#### 问题 3：删除插件后配置验证失败

**症状**：
```
Invalid config: plugins.entries.dingtalk: plugin not found: dingtalk
```

**原因**：删除插件目录后，配置文件仍然引用该插件。

**解决方案**：先安装插件，再进行其他操作

```bash
# 使用 npm pack 手动安装（见问题 1 的解决方案）
```

### 完整的安全更新流程

推荐的插件更新流程：

```bash
# 1. 本地：发布新版本到 NPM
cd /e/dingtalk-clawdbot
# 修改 package.json 版本号
npm publish --access public

# 2. 远端：验证当前版本
ssh root@172.20.90.45 "cat /home/clawd/.clawdbot/extensions/dingtalk/package.json | grep version"

# 3. 远端：尝试官方更新命令
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  clawdbot plugins update dingtalk"

# 4. 远端：验证版本是否更新
ssh root@172.20.90.45 "cat /home/clawd/.clawdbot/extensions/dingtalk/package.json | grep version"

# 5. 如果版本未更新，使用手动安装方法（见问题 1）

# 6. 远端：重启 gateway
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  clawdbot gateway restart"

# 7. 远端：检查启动日志
ssh root@172.20.90.45 "sudo -u clawd journalctl --user -u clawdbot-gateway -n 20 --no-pager"
```

## 故障排查

### 查看 Gateway 日志

```bash
# 实时日志（systemd）
ssh root@172.20.90.45 "sudo -u clawd journalctl --user -u clawdbot-gateway -f"

# 最近 N 条日志
ssh root@172.20.90.45 "sudo -u clawd journalctl --user -u clawdbot-gateway -n 50 --no-pager"

# 文件日志
ssh root@172.20.90.45 "tail -100 /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log"
```

### Gateway 状态检查

```bash
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  clawdbot gateway status"
```

### 配置诊断

```bash
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  clawdbot doctor"
```

## 常见运维操作

### 重启 Gateway

```bash
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  clawdbot gateway restart"
```

### 查看已安装插件

```bash
ssh root@172.20.90.45 "ls -la /home/clawd/.clawdbot/extensions/"
```

### 清理重复插件目录

```bash
# 删除 backup 目录
ssh root@172.20.90.45 "rm -rf /home/clawd/.clawdbot/extensions/dingtalk.backup-*"
```

---
**最后更新**: 2026-01-29
