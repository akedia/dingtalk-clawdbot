# 运维操作手册

## 插件更新

### 官方推荐方法

根据 [Openclaw 官方文档](https://docs.molt.bot/cli/plugins.md)：

```bash
# 更新单个插件
openclaw plugins update <plugin-id>

# 更新所有插件
openclaw plugins update --all

# 预览更新（不实际执行）
openclaw plugins update <plugin-id> --dry-run
```

**重要限制**：更新功能仅适用于通过 npm 安装的插件（记录在 `plugins.installs` 中）。

### 远端服务器更新命令

由于 `su - clawd` 不会建立 systemd 用户会话，必须注入环境变量：

```bash
# 正确方式（注入 systemd 环境变量）
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  bash -c 'openclaw plugins update dingtalk && openclaw gateway restart'"
```

### 已知问题与解决方案

#### 问题 1：`openclaw plugins update` 失败但无明确错误

**症状**：
```
Failed to update dingtalk: npm install failed:
```
版本号没有更新（如仍显示 1.4.0 而非 1.4.1）。

**原因**：
- **npm install 超时（最常见）**：openclaw 的 5 分钟超时对于 400+ 依赖的插件不够（实际需要 ~28 分钟）
- npm 缓存问题
- 依赖安装失败但错误信息被吞掉
- 插件目录权限问题

**根因分析**（2026-01-30）：

检查 openclaw 源码 `/usr/lib/node_modules/openclaw/dist/plugins/install.js`：
```javascript
timeoutMs: Math.max(timeoutMs, 300_000)  // npm install 超时 5 分钟
```

对比实际 npm 日志：
- 首次/冷启动安装：~28 分钟（含 postinstall 脚本、无缓存）
- 有缓存时安装：~1.5 分钟（缓存命中后很快）
- openclaw plugins update：5 分钟超时后终止，回滚到旧版本

**关键发现**：如果 npm 缓存热，5 分钟超时应该够用。失败可能因为：
1. 首次安装（无缓存）
2. 缓存过期或被清理
3. 网络抖动导致 `cache revalidated` 变慢

**相关 Issue**：建议向 [moltbot/moltbot](https://github.com/moltbot/moltbot/issues) 提交 feature request，添加 `--timeout` 参数或环境变量。

**解决方案**：手动重新安装插件

```bash
# 1. 删除旧插件目录
ssh root@172.20.90.45 "rm -rf /home/clawd/.openclaw/extensions/dingtalk"

# 2. 手动下载并安装
ssh root@172.20.90.45 "sudo -u clawd bash -c '\
  cd /home/clawd/.openclaw/extensions && \
  npm pack @yaoyuanchao/dingtalk && \
  tar -xzf yaoyuanchao-dingtalk-*.tgz && \
  mv package dingtalk && \
  rm yaoyuanchao-dingtalk-*.tgz'"

# 3. 安装依赖
ssh root@172.20.90.45 "cd /home/clawd/.openclaw/extensions/dingtalk && sudo -u clawd npm install"

# 4. 重启 gateway
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"
```

#### 问题 2：插件加载失败 - Cannot find module

**症状**：
```
[gateway] [plugins] dingtalk failed to load: Error: Cannot find module 'zod'
```

**原因**：`openclaw plugins update` 没有正确安装插件依赖。

**解决方案**：手动安装依赖

```bash
ssh root@172.20.90.45 "cd /home/clawd/.openclaw/extensions/dingtalk && sudo -u clawd npm install"
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"
```

#### 问题 3：`openclaw plugins update` 导致插件完全不可用

**症状**：
```
Failed to update dingtalk: npm install failed:
Invalid config at /home/clawd/.openclaw/openclaw.json:
- plugins.entries.dingtalk: plugin not found: dingtalk
- channels.dingtalk: unknown channel id: dingtalk
```

Gateway 无法启动，不断报错并重试。

**根本原因分析**：

`openclaw plugins update` 的更新流程是**非原子性**的：
1. 删除旧插件目录（或重命名为 `.backup-*`）
2. 下载新版本
3. 解压到插件目录
4. 运行 `npm install` 安装依赖

**问题在于**：如果步骤 4 失败，旧版本已经被删除/重命名，导致：
- 配置文件 `openclaw.json` 仍然引用 `dingtalk` 插件
- 但插件目录不存在或不完整
- 配置验证失败，Gateway 无法启动

**这次故障的具体经过** (2026-01-30)：

```bash
# 我们执行的命令
npm cache clean --force && openclaw plugins update dingtalk && openclaw gateway restart

# 实际发生的情况：
# 1. npm cache 清理成功
# 2. openclaw plugins update 开始执行
#    - 下载 @yaoyuanchao/dingtalk@1.4.8 成功
#    - 解压成功
#    - npm install 失败（原因不明，可能是网络或依赖问题）
# 3. 插件目录被清空或处于不完整状态
# 4. gateway restart 执行，但配置验证失败
# 5. Gateway 进入崩溃循环
```

**教训**：

| 我们的做法 | 问题 | 正确做法 |
|-----------|------|---------|
| 在一条命令中串联 `update` 和 `restart` | 如果 update 失败，restart 仍会执行 | 分开执行，先验证 update 成功 |
| 没有备份旧版本 | 无法回滚 | 手动备份或使用手动安装方法 |
| 没有先 `--dry-run` 测试 | 直接执行可能失败 | 先用 `--dry-run` 预览 |

**解决方案**：使用手动安装方法（不依赖 `openclaw plugins update`）

```bash
# 手动安装（原子性更强，失败时旧版本仍在）
cd /home/clawd/.openclaw/extensions
npm pack @yaoyuanchao/dingtalk@1.4.8
tar -xzf yaoyuanchao-dingtalk-1.4.8.tgz
rm -rf dingtalk.old && mv dingtalk dingtalk.old  # 备份旧版本
mv package dingtalk
cd dingtalk && npm install --omit=dev
# 验证成功后再删除 dingtalk.old
```

#### 问题 4：删除插件后配置验证失败

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

#### ⚠️ 重要警告

**不要使用**：
```bash
# ❌ 危险！如果 update 失败会导致插件不可用
openclaw plugins update dingtalk && openclaw gateway restart
```

**原因**：`openclaw plugins update` 是非原子性操作，失败时可能删除旧版本导致插件完全不可用。

#### 推荐方法 A：手动安装（最安全）

```bash
# 1. 本地：发布新版本到 NPM
cd /e/dingtalk-openclaw
npm publish --access public

# 2. 远端：备份旧版本 + 安装新版本
ssh root@172.20.90.45 "sudo -u clawd bash -c '
  cd /home/clawd/.openclaw/extensions
  # 备份旧版本
  [ -d dingtalk ] && mv dingtalk dingtalk.backup-\$(date +%s)
  # 下载新版本
  npm pack @yaoyuanchao/dingtalk
  tar -xzf yaoyuanchao-dingtalk-*.tgz
  mv package dingtalk
  rm yaoyuanchao-dingtalk-*.tgz
  # 安装依赖
  cd dingtalk && npm install --omit=dev
'"

# 3. 验证版本
ssh root@172.20.90.45 "cat /home/clawd/.openclaw/extensions/dingtalk/package.json | grep version"

# 4. 重启 gateway
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"

# 5. 验证启动成功
ssh root@172.20.90.45 "sudo -u clawd journalctl --user -u openclaw-gateway --since '30 seconds ago' --no-pager | grep -E 'Stream connected|error'"

# 6. 成功后清理备份
ssh root@172.20.90.45 "rm -rf /home/clawd/.openclaw/extensions/dingtalk.backup-*"
```

#### 方法 B：使用官方命令（有风险）

如果坚持使用官方命令，请**分步执行并验证**：

```bash
# 1. 先预览（不实际执行）
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw plugins update dingtalk --dry-run"

# 2. 备份当前版本
ssh root@172.20.90.45 "cp -r /home/clawd/.openclaw/extensions/dingtalk /home/clawd/.openclaw/extensions/dingtalk.manual-backup"

# 3. 执行更新（单独执行，不串联其他命令）
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw plugins update dingtalk"

# 4. 验证版本更新成功
ssh root@172.20.90.45 "cat /home/clawd/.openclaw/extensions/dingtalk/package.json | grep version"

# 5. 如果失败，从备份恢复
ssh root@172.20.90.45 "rm -rf /home/clawd/.openclaw/extensions/dingtalk && mv /home/clawd/.openclaw/extensions/dingtalk.manual-backup /home/clawd/.openclaw/extensions/dingtalk"

# 6. 成功后再重启
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"
```

#### 故障恢复流程

如果更新失败导致插件不可用：

```bash
# 1. 检查是否有备份
ssh root@172.20.90.45 "ls -la /home/clawd/.openclaw/extensions/ | grep dingtalk"

# 2a. 如果有备份，恢复它
ssh root@172.20.90.45 "rm -rf /home/clawd/.openclaw/extensions/dingtalk && mv /home/clawd/.openclaw/extensions/dingtalk.backup-* /home/clawd/.openclaw/extensions/dingtalk"

# 2b. 如果没有备份，手动安装
ssh root@172.20.90.45 "sudo -u clawd bash -c '
  cd /home/clawd/.openclaw/extensions
  npm pack @yaoyuanchao/dingtalk
  tar -xzf yaoyuanchao-dingtalk-*.tgz
  mv package dingtalk
  rm yaoyuanchao-dingtalk-*.tgz
  cd dingtalk && npm install --omit=dev
'"

# 3. 重启 gateway
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"
```

## 故障排查

### 查看 Gateway 日志

```bash
# 实时日志（systemd）
ssh root@172.20.90.45 "sudo -u clawd journalctl --user -u openclaw-gateway -f"

# 最近 N 条日志
ssh root@172.20.90.45 "sudo -u clawd journalctl --user -u openclaw-gateway -n 50 --no-pager"

# 文件日志
ssh root@172.20.90.45 "tail -100 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
```

### Gateway 状态检查

```bash
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway status"
```

### 配置诊断

```bash
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw doctor"
```

## 常见运维操作

### 重启 Gateway

```bash
ssh root@172.20.90.45 "sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"
```

### 查看已安装插件

```bash
ssh root@172.20.90.45 "ls -la /home/clawd/.openclaw/extensions/"
```

### 清理重复插件目录

```bash
# 删除 backup 目录
ssh root@172.20.90.45 "rm -rf /home/clawd/.openclaw/extensions/dingtalk.backup-*"
```

---
**最后更新**: 2026-01-30
