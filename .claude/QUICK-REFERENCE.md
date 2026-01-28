# 快速参考 - DingTalk Clawdbot Plugin

> 常用命令速查表，快速上手开发和部署

---

## 🔌 远端服务器连接

```bash
# 连接远端（只能用 root）
ssh root@172.20.90.45

# 切换到 clawd 用户
ssh root@172.20.90.45
su - clawd

# 以 clawd 用户执行命令（一行）
ssh root@172.20.90.45 "su - clawd -c '命令'"

# 传输文件到远端（使用 root）
scp 本地文件 root@172.20.90.45:/home/clawd/远端路径

# 从远端下载文件
scp root@172.20.90.45:/home/clawd/远端文件 本地路径

# 传输目录（递归）
scp -r 本地目录 root@172.20.90.45:/home/clawd/远端目录
```

---

## 📁 重要路径速查

| 路径 | 说明 |
|------|------|
| `/home/clawd/.clawdbot/` | Clawdbot 主目录 |
| `/home/clawd/.clawdbot/extensions/dingtalk/` | 插件目录 |
| `/home/clawd/.clawdbot/clawdbot.json` | 配置文件 |
| `/tmp/clawdbot/` | 日志目录 |
| `/home/clawd/.claude/skills/` | Claude 技能目录 |

---

## 🎯 常用操作（一键复制）

### 远端状态检查

```bash
# 查看插件列表（以 clawd 用户执行）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot plugins list'"

# 查看 Gateway 进程
ssh root@172.20.90.45 "ps aux | grep 'clawdbot gateway'"

# 查看今天的日志
ssh root@172.20.90.45 "tail -f /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log | grep dingtalk"

# 查看配置
ssh root@172.20.90.45 "cat /home/clawd/.clawdbot/clawdbot.json | jq '.channels.dingtalk'"

# 健康检查（以 clawd 用户执行）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot status --deep'"
```

### 配置备份和恢复

```bash
# 备份远端配置到本地
scp root@172.20.90.45:/home/clawd/.clawdbot/clawdbot.json \
  ./backup/remote-config-$(date +%Y%m%d).json

# 备份远端插件代码
scp -r root@172.20.90.45:/home/clawd/.clawdbot/extensions/dingtalk \
  ./backup/remote-plugin-$(date +%Y%m%d)

# 恢复配置到远端
scp ./backup/remote-config-YYYYMMDD.json \
  root@172.20.90.45:/home/clawd/.clawdbot/clawdbot.json
```

### Gateway 管理

```bash
# 停止 Gateway（直接 kill 进程）
ssh root@172.20.90.45 "pkill -f 'clawdbot gateway'"

# 启动 Gateway（以 clawd 用户，后台）
ssh root@172.20.90.45 "su - clawd -c 'nohup clawdbot gateway > /dev/null 2>&1 &'"

# 重启 Gateway
ssh root@172.20.90.45 "pkill -f 'clawdbot gateway' && su - clawd -c 'nohup clawdbot gateway > /dev/null 2>&1 &'"

# 查看 Gateway 状态（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot status'"
```

### 插件管理（远端）

```bash
# 安装插件（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot plugins install @yaoyuanchao/dingtalk'"

# 更新插件（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot plugins update @yaoyuanchao/dingtalk'"

# 卸载插件（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot plugins uninstall dingtalk'"

# 配置向导（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot onboard --channel dingtalk'"

# 验证配置（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot doctor'"
```

---

## 💻 本地开发

### Git 操作

```bash
cd e:\dingtalkclawd

# 查看状态
git status

# 查看提交历史
git log --oneline -10

# 查看改动
git diff

# 提交改动
git add .
git commit -m "type(scope): description

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

# 推送到 GitHub（首次）
git push -u origin main

# 推送到 GitHub（后续）
git push

# 推送标签
git push --tags
```

### NPM 操作

```bash
cd e:\dingtalkclawd

# 安装依赖
npm install

# 本地打包
npm pack

# 查看包内容
tar -tzf yaoyuanchao-dingtalk-1.2.0.tgz

# 发布到 NPM（需要先登录）
npm publish --access public

# 查看已发布的包
npm view @yaoyuanchao/dingtalk version
```

### 本地测试

```bash
# 本地安装测试
clawdbot plugins install ./yaoyuanchao-dingtalk-1.2.0.tgz

# 列出已安装插件
clawdbot plugins list

# 运行配置向导
clawdbot onboard --channel dingtalk

# 启动 Gateway（本地测试）
clawdbot gateway
```

---

## 🐛 故障排查

### 问题 1: 插件安装失败（权限错误）

```bash
# 检查权限
ssh root@172.20.90.45 "ls -ld /home/clawd/.clawdbot/extensions"

# 修复权限
ssh root@172.20.90.45 "mkdir -p /home/clawd/.clawdbot/extensions && chown -R clawd:clawd /home/clawd/.clawdbot/extensions"

# 重新安装（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot plugins install @yaoyuanchao/dingtalk'"
```

### 问题 2: Gateway 无法连接

```bash
# 查看详细日志
ssh root@172.20.90.45 "tail -100 /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log"

# 检查配置（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot doctor'"

# 测试健康检查（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot status --deep'"

# 检查进程
ssh root@172.20.90.45 "ps aux | grep clawdbot"

# 重启 Gateway
ssh root@172.20.90.45 "pkill -f 'clawdbot gateway' && su - clawd -c 'clawdbot gateway'"
```

### 问题 3: 配置验证失败

```bash
# 查看配置
ssh root@172.20.90.45 "cat /home/clawd/.clawdbot/clawdbot.json | jq '.channels.dingtalk'"

# 重新运行配置向导（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot onboard --channel dingtalk'"

# 手动编辑配置
ssh root@172.20.90.45 "nano /home/clawd/.clawdbot/clawdbot.json"
```

### 问题 4: 消息收不到

```bash
# 查看日志中的 staffId
ssh root@172.20.90.45 "grep 'staffId' /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log"

# 查看日志中的 conversationId
ssh root@172.20.90.45 "grep 'conversationId' /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log"

# 查看白名单配置
ssh root@172.20.90.45 "cat /home/clawd/.clawdbot/clawdbot.json | jq '.channels.dingtalk.dm.allowFrom'"
ssh root@172.20.90.45 "cat /home/clawd/.clawdbot/clawdbot.json | jq '.channels.dingtalk.groupAllowlist'"
```

---

## 📊 日志分析

### 实时查看日志

```bash
# 查看所有 dingtalk 相关日志
ssh root@172.20.90.45 "tail -f /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log | grep dingtalk"

# 查看 Stream 连接日志
ssh root@172.20.90.45 "tail -f /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log | grep 'Stream connected'"

# 查看错误日志
ssh root@172.20.90.45 "tail -f /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log | grep -i error"

# 查看最近 100 行日志
ssh root@172.20.90.45 "tail -100 /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log"
```

### 历史日志搜索

```bash
# 搜索特定日期的日志
ssh root@172.20.90.45 "cat /tmp/clawdbot/clawdbot-2026-01-28.log | grep dingtalk"

# 搜索包含特定内容的日志
ssh root@172.20.90.45 "grep -r 'staffId' /tmp/clawdbot/*.log"

# 统计错误次数
ssh root@172.20.90.45 "grep -c 'error' /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log"
```

---

## 🚀 快速部署流程

### 完整部署流程（本地开发 → NPM → 远端）

```bash
# 1. 本地开发和测试
cd e:\dingtalkclawd
git add .
git commit -m "feat: new feature"
npm pack

# 2. 发布到 NPM
npm publish --access public

# 3. 更新远端（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot plugins update @yaoyuanchao/dingtalk'"

# 4. 重启 Gateway
ssh root@172.20.90.45 "pkill -f 'clawdbot gateway' && su - clawd -c 'nohup clawdbot gateway > /dev/null 2>&1 &'"

# 5. 验证
ssh root@172.20.90.45 "su - clawd -c 'clawdbot plugins list | grep dingtalk'"
ssh root@172.20.90.45 "tail -20 /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log | grep dingtalk"

# 6. 推送到 GitHub
git push
```

### 紧急回滚流程

```bash
# 1. 恢复配置
scp ./backup/remote-config-YYYYMMDD.json root@172.20.90.45:/home/clawd/.clawdbot/clawdbot.json

# 2. 停止 Gateway
ssh root@172.20.90.45 "pkill -f 'clawdbot gateway'"

# 3. 删除新版本
ssh root@172.20.90.45 "rm -rf /home/clawd/.clawdbot/extensions/dingtalk"

# 4. 安装旧版本（需要旧版本代码）
scp -r ./backup/remote-plugin-YYYYMMDD root@172.20.90.45:/home/clawd/.clawdbot/extensions/dingtalk

# 5. 修复权限
ssh root@172.20.90.45 "chown -R clawd:clawd /home/clawd/.clawdbot/extensions/dingtalk"

# 6. 启动 Gateway（以 clawd 用户）
ssh root@172.20.90.45 "su - clawd -c 'clawdbot gateway'"
```

---

## 📝 配置模板

### 最小配置（仅凭证）

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "your-client-id",
      "clientSecret": "your-client-secret"
    }
  },
  "plugins": {
    "entries": {
      "dingtalk": {
        "enabled": true
      }
    }
  }
}
```

### 完整配置（所有选项）

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "your-client-id",
      "clientSecret": "your-client-secret",
      "robotCode": "your-robot-code",
      "dm": {
        "enabled": true,
        "policy": "pairing",
        "allowFrom": ["staffId1", "staffId2"]
      },
      "groupPolicy": "allowlist",
      "groupAllowlist": ["conversationId1", "conversationId2"],
      "requireMention": true,
      "messageFormat": "text",
      "textChunkLimit": 2000
    }
  },
  "plugins": {
    "entries": {
      "dingtalk": {
        "enabled": true
      }
    }
  }
}
```

---

## 🔗 相关链接

- **NPM 包**: https://www.npmjs.com/package/@yaoyuanchao/dingtalk
- **GitHub 仓库**: https://github.com/akedia/dingtalk-clawdbot
- **主文档**: [CLAUDE.md](./CLAUDE.md)
- **升级指南**: [../UPGRADE.md](../UPGRADE.md)
- **兼容性说明**: [../COMPATIBILITY.md](../COMPATIBILITY.md)

---

**最后更新**: 2026-01-28
