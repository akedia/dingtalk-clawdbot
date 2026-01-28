# 升级指南 - v0.1.0 → v1.2.0

## 概述

如果你之前通过手动复制源码方式安装了 DingTalk 插件 v0.1.0，本文档将指导你升级到官方 NPM 版本 v1.2.0。

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
| 配置验证 | JSON Schema | Zod (类型安全) |
| 配置向导 | ❌ 无 | ✅ 交互式 |
| 健康检查 | ❌ 无 | ✅ 延迟监控 |
| 升级方式 | 手动替换文件 | `npm update` |

## 升级步骤

### 步骤 1: 备份配置

**重要**: 必须先备份配置，避免数据丢失！

```bash
# 备份整个配置文件
cp ~/.clawdbot/clawdbot.json ~/.clawdbot/clawdbot.json.backup-$(date +%Y%m%d)

# 单独导出 DingTalk 配置（可选）
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk' > ~/dingtalk-config-backup.json
```

### 步骤 2: 停止 Gateway

```bash
clawdbot gateway stop

# 或者如果使用 systemd
sudo systemctl stop clawdbot-gateway
```

### 步骤 3: 删除旧版本代码

```bash
# 删除手动安装的插件目录
rm -rf ~/.clawdbot/extensions/dingtalk

# 如果有 node_modules，一并删除
rm -rf ~/.clawdbot/extensions/dingtalk
```

### 步骤 4: 清理配置文件引用（临时）

编辑 `~/.clawdbot/clawdbot.json`，临时移除 dingtalk 配置：

```bash
# 方法1: 使用 Python 脚本自动清理
python3 << 'EOF'
import json

with open('/home/YOUR_USER/.clawdbot/clawdbot.json', 'r') as f:
    config = json.load(f)

# 备份 dingtalk 配置
dingtalk_config = config.get('channels', {}).pop('dingtalk', None)
if 'plugins' in config and 'entries' in config['plugins']:
    config['plugins']['entries'].pop('dingtalk', None)

# 保存清理后的配置
with open('/home/YOUR_USER/.clawdbot/clawdbot.json', 'w') as f:
    json.dump(config, f, indent=2)

# 保存 dingtalk 配置到临时文件
if dingtalk_config:
    with open('/tmp/dingtalk-temp-config.json', 'w') as f:
        json.dump(dingtalk_config, f, indent=2)
    print("DingTalk config saved to /tmp/dingtalk-temp-config.json")
EOF

# 方法2: 手动编辑
nano ~/.clawdbot/clawdbot.json
# 删除 channels.dingtalk 整个节点
# 删除 plugins.entries.dingtalk 整个节点
```

### 步骤 5: 安装新版本

```bash
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

### 步骤 6A: 恢复配置（手动方式）

编辑 `~/.clawdbot/clawdbot.json`，恢复 dingtalk 配置：

```bash
# 读取备份的配置
cat /tmp/dingtalk-temp-config.json

# 手动编辑配置文件
nano ~/.clawdbot/clawdbot.json
```

添加回 channels.dingtalk 和 plugins.entries.dingtalk 节点。

### 步骤 6B: 恢复配置（脚本方式）

```bash
python3 << 'EOF'
import json

# 读取当前配置
with open('/home/YOUR_USER/.clawdbot/clawdbot.json', 'r') as f:
    config = json.load(f)

# 读取备份的 dingtalk 配置
with open('/tmp/dingtalk-temp-config.json', 'r') as f:
    dingtalk_config = json.load(f)

# 恢复配置
if 'channels' not in config:
    config['channels'] = {}
config['channels']['dingtalk'] = dingtalk_config

if 'plugins' not in config:
    config['plugins'] = {}
if 'entries' not in config['plugins']:
    config['plugins']['entries'] = {}
config['plugins']['entries']['dingtalk'] = {'enabled': True}

# 保存
with open('/home/YOUR_USER/.clawdbot/clawdbot.json', 'w') as f:
    json.dump(config, f, indent=2)

print("DingTalk config restored!")
EOF
```

### 步骤 7: 验证配置

```bash
# 验证配置文件格式正确
clawdbot doctor

# 检查插件状态
clawdbot plugins list | grep -A 2 dingtalk
```

预期输出：
```
│ DingTalk │ dingtalk │ loaded │ ~/.clawdbot/extensions/dingtalk/index.ts │ 1.2.0 │
```

### 步骤 8: 启动 Gateway

```bash
clawdbot gateway

# 或者如果使用 systemd
sudo systemctl start clawdbot-gateway
```

### 步骤 9: 检查运行状态

```bash
# 查看 DingTalk 频道状态
clawdbot status channels

# 查看日志验证连接
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep dingtalk
```

预期日志：
```
[dingtalk] Starting Stream connection...
[dingtalk:default] Starting Stream...
[dingtalk:default] Stream connected
[dingtalk] Stream connection started successfully
```

## 故障排查

### 问题 1: 权限错误

**错误**: `EACCES: permission denied, mkdir '/home/xxx/.clawdbot/extensions/dingtalk'`

**原因**: extensions 目录权限不正确（可能之前用 root 安装过）

**解决**:
```bash
# 如果是自己的用户目录
chown -R $(whoami):$(whoami) ~/.clawdbot/extensions

# 如果需要 sudo
sudo chown -R $USER:$USER ~/.clawdbot/extensions
```

### 问题 2: 配置验证失败

**错误**: `plugins.entries.dingtalk: plugin not found: dingtalk`

**原因**: 配置文件中有旧的插件引用

**解决**:
```bash
# 检查配置文件
clawdbot doctor

# 清理配置引用（重复步骤 4）
# 然后重新安装（重复步骤 5-6）
```

### 问题 3: Stream 连接失败

**错误**: 日志中显示 `Failed to start Stream`

**原因**:
- clientId 或 clientSecret 配置错误
- 钉钉应用未启用 Stream 模式

**解决**:
```bash
# 验证配置
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk'

# 运行配置向导重新设置
clawdbot onboard --channel dingtalk
```

### 问题 4: 找不到旧配置

**错误**: 步骤 4 清理后，忘记保存配置到临时文件

**解决**:
```bash
# 从备份恢复
cp ~/.clawdbot/clawdbot.json.backup-YYYYMMDD ~/.clawdbot/clawdbot.json

# 重新执行升级流程，这次注意保存配置
```

## 使用新功能

### 交互式配置向导

升级后，你可以使用新的配置向导：

```bash
clawdbot onboard --channel dingtalk
```

这会引导你：
1. 输入凭证
2. 自动测试连接
3. 选择访问策略
4. 自动保存配置

### 健康检查

检查 DingTalk 连接状态和延迟：

```bash
clawdbot status --deep
```

输出会显示：
```
│ DingTalk │ ON │ OK │ latency: 245ms │
```

## 回滚到旧版本

如果升级后遇到问题，可以回滚：

```bash
# 1. 停止 gateway
clawdbot gateway stop

# 2. 卸载新版本
rm -rf ~/.clawdbot/extensions/dingtalk

# 3. 恢复备份的配置
cp ~/.clawdbot/clawdbot.json.backup-YYYYMMDD ~/.clawdbot/clawdbot.json

# 4. 重新安装旧版本（从备份目录）
# 或者联系管理员获取旧版本代码

# 5. 启动 gateway
clawdbot gateway
```

## 配置兼容性说明

### messageFormat 配置

v0.1.0 的 `messageFormat` 配置在 v1.2.0 中**完全兼容**：

| v0.1.0 值 | v1.2.0 支持 | 说明 |
|-----------|------------|------|
| `"text"` | ✅ 支持 | 纯文本（推荐） |
| `"markdown"` | ✅ 支持 | Markdown 格式 |
| `"richtext"` | ✅ 支持 | 作为 markdown 的别名（deprecated） |

**重要**: 如果你的旧配置使用 `"richtext"`，**无需修改**，v1.2.0 会自动兼容。但建议在方便时改为 `"text"` 或 `"markdown"`。

详见: [COMPATIBILITY.md](./COMPATIBILITY.md)

## 常见问题 (FAQ)

### Q1: 升级后配置会丢失吗？
A: 不会，只要按照步骤备份和恢复配置，所有设置都会保留。

### Q2: 旧版本的 staffId 白名单会保留吗？
A: 会保留，配置格式完全兼容。

### Q3: 升级需要重新获取 staffId 吗？
A: 不需要，旧的 staffId 继续有效。

### Q4: 升级后需要重新配置钉钉应用吗？
A: 不需要，钉钉应用端无需任何修改。

### Q5: 能否保留旧版本和新版本共存？
A: 不建议，会导致配置冲突。应该完全替换。

### Q6: 升级后如何验证功能正常？
A:
1. 在钉钉中发送私聊消息测试
2. 在群聊中 @机器人测试
3. 查看日志确认消息收发正常

## 获取帮助

如果升级过程中遇到问题：

1. 查看日志: `tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log`
2. 运行诊断: `clawdbot doctor`
3. 查看 GitHub Issues: https://github.com/akedia/dingtalk-clawdbot/issues
4. 阅读文档: [README.md](./README.md), [CHANGELOG.md](./CHANGELOG.md)

## 下次升级

从 v1.2.0 开始，升级变得简单：

```bash
# 停止 gateway
clawdbot gateway stop

# 升级插件
clawdbot plugins update @yaoyuanchao/dingtalk

# 启动 gateway
clawdbot gateway
```

配置会自动保留，无需手动备份！

---

**升级建议**: 建议在非工作时间进行升级，整个过程大约需要 5-10 分钟。
