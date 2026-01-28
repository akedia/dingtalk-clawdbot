# 安装过程问题分析

## 本次部署遇到的问题

### 1. 权限问题 (EACCES)
**错误**: `EACCES: permission denied, mkdir '/home/clawd/.clawdbot/extensions/dingtalk'`

**原因**:
- 我们在 root 用户下删除了旧插件
- extensions 目录不存在或权限不正确
- 然后切换到 clawd 用户安装时无权限创建

**解决方法**:
```bash
mkdir -p /home/clawd/.clawdbot/extensions
chown -R clawd:clawd /home/clawd/.clawdbot/extensions
```

**其他用户是否会遇到？**
- ❌ **全新安装用户**: 不会遇到，clawdbot 会自动创建目录
- ⚠️ **从手动安装升级的用户**: 可能遇到，如果之前用 root 安装过
- ✅ **解决方案**: 在文档中添加升级指南

---

### 2. 配置验证失败
**错误**: `plugins.entries.dingtalk: plugin not found: dingtalk`

**原因**:
- 删除旧插件后，配置文件中仍保留引用
- channels.dingtalk 和 plugins.entries.dingtalk 配置指向不存在的插件

**解决方法**:
```bash
# 方法1: 先删除配置引用，再安装
# 方法2: 使用 clawdbot doctor --fix (但无法自动修复)
```

**其他用户是否会遇到？**
- ❌ **全新安装用户**: 不会遇到
- ✅ **从旧版本升级的用户**: **会遇到！** 这是升级的必经问题
- ⚠️ **需要改进**: 应该提供升级脚本或文档

---

## 用户可能遇到的问题分类

### A. 全新安装用户 (不会遇到)
执行流程：
```bash
clawdbot plugins install @yaoyuanchao/dingtalk
clawdbot onboard --channel dingtalk
clawdbot gateway
```
✅ 预期顺利，无特殊问题

---

### B. 从手动安装升级的用户 (会遇到问题)

#### 问题1: 不知道如何卸载旧版本
**现象**: 不知道旧版本在哪里，如何删除

**解决**: 需要提供升级文档
```bash
# 查看当前安装位置
clawdbot plugins list

# 如果显示本地路径，需要删除
rm -rf ~/.clawdbot/extensions/dingtalk
```

#### 问题2: 配置冲突
**现象**: 安装新版本后，配置验证失败

**根本原因**: 
- 旧版本使用的是手动复制的代码
- 配置文件 plugins.entries 中没有 dingtalk 条目（或有错误条目）
- 删除旧代码后，配置引用失效

**解决方案**: 
```bash
# 方案1: 临时禁用 dingtalk
# 编辑 ~/.clawdbot/clawdbot.json
# 删除 channels.dingtalk
# 删除 plugins.entries.dingtalk
# 然后重新安装和配置

# 方案2: 使用 clawdbot plugins uninstall (如果支持)
clawdbot plugins uninstall dingtalk
```

#### 问题3: 权限问题（如果用 root 安装过）
**现象**: 用普通用户安装时报权限错误

**解决**:
```bash
# 需要 root 权限修复
sudo chown -R $(whoami):$(whoami) ~/.clawdbot/extensions
```

---

## 需要改进的地方

### 1. 提供升级脚本
创建 `UPGRADE.md` 文档，明确升级步骤：

```markdown
# 从 v0.1.0 手动安装升级到 v1.2.0 NPM 版本

## 步骤1: 备份配置
cp ~/.clawdbot/clawdbot.json ~/.clawdbot/clawdbot.json.backup

## 步骤2: 停止 gateway
clawdbot gateway stop

## 步骤3: 删除旧版本
rm -rf ~/.clawdbot/extensions/dingtalk

## 步骤4: 清理配置引用
# 编辑 ~/.clawdbot/clawdbot.json
# 临时删除 channels.dingtalk 和 plugins.entries.dingtalk 节点

## 步骤5: 安装新版本
clawdbot plugins install @yaoyuanchao/dingtalk

## 步骤6: 恢复配置
# 将备份的 channels.dingtalk 配置复制回来

## 步骤7: 启动 gateway
clawdbot gateway
```

### 2. 在 README 中添加升级章节
```markdown
## 升级指南

### 从 v0.1.0 手动安装升级

如果你之前通过手动复制源码安装，请按以下步骤升级：
[链接到 UPGRADE.md]
```

### 3. 在 NPM 发布说明中提及
```markdown
## ⚠️ 升级注意事项

如果你从 v0.1.0 手动安装版本升级，请先：
1. 备份配置
2. 删除旧版本目录
3. 清理配置文件引用
详见: UPGRADE.md
```

### 4. 考虑提供卸载脚本
可以在 package.json 中添加 preuninstall 脚本，或者提供命令行工具：
```bash
clawdbot plugins uninstall dingtalk --clean-config
```

---

## 测试建议

### 测试场景1: 全新安装
- [ ] 在干净环境中安装
- [ ] 验证 onboarding 流程
- [ ] 验证 Stream 连接

### 测试场景2: 从 v0.1.0 升级
- [ ] 备份旧配置
- [ ] 测试升级流程
- [ ] 验证配置迁移
- [ ] 验证功能正常

### 测试场景3: 权限问题模拟
- [ ] 模拟 extensions 目录权限问题
- [ ] 验证错误提示是否清晰
- [ ] 验证修复步骤

---

## 总结

### 对其他用户的影响评估

| 用户类型 | 影响程度 | 问题描述 | 是否需要文档 |
|---------|---------|---------|------------|
| 全新安装 | ✅ 无影响 | 标准安装流程顺畅 | 现有 README 足够 |
| 旧版升级 | ⚠️ 中等影响 | 需要手动清理配置 | **需要 UPGRADE.md** |
| Root安装过 | ⚠️ 小影响 | 可能有权限问题 | 需要在升级文档中说明 |

### 优先级排序

1. **高优先级**: 创建 UPGRADE.md 升级文档
2. **中优先级**: 在 README 中添加升级章节
3. **低优先级**: 提供自动化升级脚本

### 建议的下一步行动

```bash
# 1. 创建升级文档
echo "创建 UPGRADE.md"

# 2. 更新 README.md 添加升级章节
echo "在 README 中添加 '## 升级指南' 章节"

# 3. 更新 NPM 包的发布说明
echo "在下次发布时在 npm 页面添加升级提示"

# 4. 考虑在 v1.2.1 中添加升级检测
echo "检测旧版本并给出友好提示"
```
