# 🚀 快速升级指南 (v0.1.0 → v1.2.0)

**适用于**: 已经手动安装 DingTalk 插件 v0.1.0 的用户

## 最简单的方法：一键升级脚本

### 下载并运行升级脚本

```bash
# 下载升级脚本
curl -fsSL https://raw.githubusercontent.com/yaoyuanchao/dingtalk-clawdbot/main/upgrade-from-v0.1.0.sh -o /tmp/upgrade-dingtalk.sh

# 运行升级
bash /tmp/upgrade-dingtalk.sh
```

**或者**，如果你克隆了仓库：

```bash
git clone https://github.com/akedia/dingtalk-clawdbot.git
cd dingtalk-clawdbot
bash upgrade-from-v0.1.0.sh
```

### 脚本会自动完成：

✅ 备份你的配置
✅ 删除旧版本
✅ 安装 NPM 新版本
✅ 恢复配置
✅ 验证安装

**整个过程不到 1 分钟！**

---

## 如果不想用脚本，手动升级（3 步）

### 第 1 步: 备份配置

```bash
cp ~/.clawdbot/clawdbot.json ~/.clawdbot/clawdbot.json.backup
```

### 第 2 步: 删除旧版本

```bash
rm -rf ~/.clawdbot/extensions/dingtalk
```

### 第 3 步: 安装新版本

```bash
clawdbot plugins install @yaoyuanchao/dingtalk
```

**注意**: 安装后需要手动恢复配置文件中的 `channels.dingtalk` 配置。

---

## 升级后验证

```bash
# 1. 检查版本
clawdbot plugins list | grep dingtalk
# 应该显示: │ DingTalk │ dingtalk │ loaded │ ... │ 1.2.0 │

# 2. 验证配置
clawdbot doctor

# 3. 启动 Gateway
clawdbot gateway

# 4. 查看日志
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep dingtalk
# 应该看到: [dingtalk:default] Stream connected
```

---

## 常见问题

### Q: 升级后配置会丢失吗？
A: 不会！脚本会自动备份和恢复，或者手动升级时从备份恢复即可。

### Q: 我的 staffId 白名单会保留吗？
A: 会保留，配置格式 100% 兼容。

### Q: 升级需要重新配置钉钉应用吗？
A: 不需要，钉钉应用端无需任何修改。

### Q: 升级失败怎么办？
A: 脚本会自动恢复备份。或者手动运行:
```bash
cp ~/.clawdbot/clawdbot.json.backup ~/.clawdbot/clawdbot.json
```

### Q: 如果我的配置使用 `messageFormat: "richtext"`？
A: **完全兼容**，v1.2.0 继续支持 richtext（作为 markdown 的别名）。

---

## 升级带来的新功能

🎉 **官方 NPM 安装** - 不再需要手动复制代码
🎉 **交互式配置向导** - `clawdbot onboard --channel dingtalk`
🎉 **类型安全验证** - Zod schema 提供详细错误提示
🎉 **健康检查** - 自动监控连接状态和延迟
🎉 **简化升级** - 下次只需 `clawdbot plugins update`

---

## 需要帮助？

- 📖 详细升级文档: [UPGRADE.md](./UPGRADE.md)
- 🔧 兼容性说明: [COMPATIBILITY.md](./COMPATIBILITY.md)
- 🐛 问题反馈: [GitHub Issues](https://github.com/akedia/dingtalk-clawdbot/issues)
- 📝 完整文档: [README.md](./README.md)

---

**升级建议**: 选择非工作时间进行，整个过程约 1-2 分钟。
