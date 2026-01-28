# DingTalk Clawdbot Plugin - 项目认知文档

> 本文档包含项目的完整上下文信息，帮助 Claude Code 快速还原认知。

---

## 📋 项目概述

### 项目名称
**DingTalk Channel Plugin for Clawdbot** (官方 NPM 插件版本)

### 项目目标
将原本手动安装的 DingTalk 插件（v0.1.0）改造为支持官方 NPM 安装的插件（v1.2.0），并保持 100% 向后兼容。

### 当前状态
- ✅ **开发完成** - 所有功能已实现
- ✅ **NPM 已发布** - [@yaoyuanchao/dingtalk@1.2.0](https://www.npmjs.com/package/@yaoyuanchao/dingtalk)
- ✅ **远端测试通过** - 已在生产环境验证
- ✅ **文档完整** - 升级指南、兼容性说明等齐全
- 🔄 **待推送 GitHub** - 远程仓库已配置但代码未推送

### 参考项目
- **飞书插件**: [@m1heng-clawd/feishu](https://github.com/m1heng/clawdbot-feishu)
  - 借鉴了 NPM 配置、Zod 验证、Onboarding 向导、健康检查等最佳实践

---

## 🖥️ 远端服务器信息

### 服务器连接
```bash
# 主要服务器（Clawdbot 生产环境）
Host: 172.20.90.45
User: clawd（开发）/ root（部署）
SSH: ssh clawd@172.20.90.45
     ssh root@172.20.90.45
```

### 重要目录路径

| 路径 | 说明 | 所有者 |
|------|------|--------|
| `/home/clawd/.clawdbot/` | Clawdbot 主目录 | clawd:clawd |
| `/home/clawd/.clawdbot/extensions/dingtalk/` | 当前插件目录（v1.2.0 NPM 版） | clawd:clawd |
| `/home/clawd/.clawdbot/clawdbot.json` | 配置文件 | clawd:clawd |
| `/tmp/clawdbot/` | 日志目录 | clawd:clawd |
| `/home/clawd/.claude/skills/` | Claude 技能目录 | clawd:clawd |

### 远端当前状态
```bash
# 插件版本
clawdbot plugins list | grep dingtalk
# → dingtalk 1.2.0 (已安装 via NPM)

# Gateway 状态
ps aux | grep "clawdbot gateway"
# → 运行中，Stream connected

# 配置情况
cat /home/clawd/.clawdbot/clawdbot.json | jq '.channels.dingtalk'
# → 使用 v0.1.0 兼容配置（messageFormat: text）
```

### 远端常用操作
```bash
# 重启 Gateway
ssh clawd@172.20.90.45 "pkill -f 'clawdbot gateway' && clawdbot gateway > /dev/null 2>&1 &"

# 查看日志
ssh clawd@172.20.90.45 "tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep dingtalk"

# 检查插件状态
ssh clawd@172.20.90.45 "clawdbot plugins list"

# 查看配置
ssh clawd@172.20.90.45 "cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk'"

# 备份配置
scp clawd@172.20.90.45:~/.clawdbot/clawdbot.json ./remote-config-backup-$(date +%Y%m%d).json
```

---

## 📁 本地开发环境

### 目录结构
```
e:\dingtalkclawd\              # 开发主目录
├── .claude\                   # Claude Code 项目配置（本文档所在）
│   └── CLAUDE.md              # 项目认知文档
├── .git\                      # Git 仓库
├── src\                       # 源代码目录
│   ├── accounts.ts            # 账户解析和配置验证
│   ├── api.ts                 # DingTalk API 封装
│   ├── channel.ts             # 频道插件主实现
│   ├── config-schema.ts       # Zod 配置验证 schema
│   ├── monitor.ts             # Stream 监听和消息处理
│   ├── onboarding.ts          # 交互式配置向导
│   ├── probe.ts               # 健康检查探测
│   ├── runtime.ts             # Runtime 全局引用
│   └── types.ts               # TypeScript 类型定义
├── index.ts                   # 插件入口
├── package.json               # NPM 包配置
├── package-lock.json          # NPM 依赖锁定
├── .gitignore                 # Git 忽略规则
├── LICENSE                    # MIT 许可证
├── README.md                  # 项目说明
├── CHANGELOG.md               # 版本变更日志
├── COMPATIBILITY.md           # 兼容性说明
├── UPGRADE.md                 # 详细升级指南
├── QUICK-UPGRADE.md           # 快速升级指南
├── INSTALLATION-ISSUES.md     # 安装问题分析
├── DEPLOYMENT-SUMMARY.md      # 部署总结
├── upgrade-from-v0.1.0.sh     # 一键升级脚本
├── 分享给老用户.md             # 用户友好升级通知
├── 给用户的升级方案总结.md      # 完整升级方案总结
├── 实际可用的分享方案.md        # 不依赖 GitHub 的分发方案
├── clawdbot.plugin.json       # 插件元数据
└── config-example.json        # 配置示例

备份目录：
e:\dingtalk-backup-20260128\   # 生产环境 v0.1.0 完整备份（433 文件）
```

### 重要文件说明

#### 核心代码文件

**src/config-schema.ts** (116 行)
- Zod 配置验证 schema
- 支持 text / markdown / richtext 三种 messageFormat
- 严格类型检查，详细错误提示

**src/accounts.ts** (90 行)
- 解析配置文件和环境变量
- 调用 Zod 验证
- 返回 ResolvedDingTalkAccount

**src/channel.ts** (185 行)
- 实现 ChannelPlugin 接口
- 注册 onboarding 和 probe
- 提供 resolveAccount、sendMessage、registerMonitor

**src/monitor.ts** (622 行)
- DingTalk Stream 连接管理
- 消息接收和路由
- 图片下载和临时文件管理
- 访问控制（pairing/allowlist/open）

**src/onboarding.ts** (152 行)
- 交互式配置向导
- 凭证测试
- 策略选择
- 自动保存配置

**src/probe.ts** (35 行)
- 健康检查
- 延迟测量
- Access Token 验证

#### 配置和打包

**package.json**
- NPM 包名: `@yaoyuanchao/dingtalk`
- 版本: `1.2.0`
- 关键配置: `clawdbot.install` 字段启用官方安装

**index.ts**
- 插件入口
- 导出 plugin 对象
- 注册 configSchema 和 channel

#### 文档体系

**升级文档（三层）**:
1. `分享给老用户.md` - 最简单，一键升级（推荐给所有人）
2. `QUICK-UPGRADE.md` - 快速指南（自动+手动两种方式）
3. `UPGRADE.md` - 完整详细步骤（7 步骤 + 故障排查）

**补充文档**:
- `COMPATIBILITY.md` - v0.1.0 vs v1.2.0 兼容性详细对比
- `INSTALLATION-ISSUES.md` - 安装过程中遇到的问题和解决方案
- `给用户的升级方案总结.md` - 完整总结，给自己看的
- `实际可用的分享方案.md` - 4 种分发方式（不依赖 GitHub）

#### 自动化工具

**upgrade-from-v0.1.0.sh** (211 行)
- 一键升级脚本
- 自动化：备份 → 提取配置 → 清理 → 安装 → 恢复 → 验证
- 彩色输出，详细错误处理

---

## 🛠️ 开发约定和技术栈

### 技术栈
- **语言**: TypeScript (type: module)
- **运行时**: Node.js (Clawdbot 运行环境)
- **验证**: Zod 3.22.0（配置 schema 验证）
- **DingTalk SDK**: dingtalk-stream 2.1.4
- **打包**: NPM publish（发布 TypeScript 源码，不编译）

### 关键设计决策

**1. Zod 验证**
- 替代原来的 JSON Schema
- 提供类型安全和详细错误提示
- 100% 兼容旧配置格式

**2. messageFormat 兼容性**
```typescript
// 支持三种格式（向后兼容）
messageFormatSchema = z.enum(['text', 'markdown', 'richtext'])
// 'richtext' 是 'markdown' 的 deprecated 别名
```

**3. 访问控制策略**
- **DM**: disabled / pairing / allowlist / open
  - `pairing` 模式：首次联系自动显示 staffId，需管理员添加白名单
- **Group**: disabled / allowlist / open
  - 群聊白名单使用 `conversationId`

**4. 双路由消息发送**
- **SessionWebhook** (优先): 35 分钟内快速回复，支持 Markdown
- **REST API** (兜底): Session 过期时使用，纯文本

**5. 环境变量支持**
```bash
DINGTALK_CLIENT_ID=<AppKey>
DINGTALK_CLIENT_SECRET=<AppSecret>
DINGTALK_ROBOT_CODE=<RobotCode>
```

### Git 工作流

**当前分支**: main
**远程仓库**: https://github.com/akedia/dingtalk-clawdbot.git (已配置但未推送)

**Commit 历史**:
```
a505d76 chore: add zod dependency to package-lock.json
a91efd1 docs: add comprehensive upgrade solution summary
ce17a62 docs: add user-friendly upgrade guide for distribution
03f4bb0 feat: add one-click upgrade script for v0.1.0 users
ef1269f docs: add comprehensive compatibility documentation
173e9fb fix: add 'richtext' to messageFormat schema for backward compatibility
651d76e feat: transform to official NPM plugin with Zod validation and onboarding
35fc986 Initial commit: v0.1.0 from production
```

**Commit Message 格式** (遵循 Conventional Commits):
```
<type>(<scope>): <subject>

<body>

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

**推送到 GitHub** (尚未执行):
```bash
cd e:\dingtalkclawd
git push -u origin main
git push --tags
```

---

## 📦 NPM 发布信息

### 包信息
- **包名**: `@yaoyuanchao/dingtalk`
- **版本**: `1.2.0`
- **NPM URL**: https://www.npmjs.com/package/@yaoyuanchao/dingtalk
- **发布状态**: ✅ 已发布（2026-01-28）
- **包大小**: 22.5 kB 压缩，73.0 kB 解压，15 文件

### 安装方式
```bash
# 官方安装（推荐）
clawdbot plugins install @yaoyuanchao/dingtalk

# 或者通过 NPM
npm install @yaoyuanchao/dingtalk
```

### 发布流程
```bash
# 1. 构建和测试
npm install
npm pack
tar -tzf yaoyuanchao-dingtalk-1.2.0.tgz

# 2. 登录 NPM（使用 granular access token）
npm config set //registry.npmjs.org/:_authToken npm_YOUR_TOKEN_HERE

# 3. 发布
npm publish --access public

# 4. 验证
npm view @yaoyuanchao/dingtalk version
clawdbot plugins install @yaoyuanchao/dingtalk
```

### NPM Token 配置
- **认证方式**: Granular Access Token (2FA 启用)
- **Token 存储**: `~/.npmrc` (已配置)
- **权限**: Publish and manage packages

---

## 🔧 常用命令和操作

### 本地开发

```bash
# 进入项目目录
cd e:\dingtalkclawd

# 安装依赖
npm install

# 查看文件树
tree -L 2 -I 'node_modules'

# 打包测试
npm pack

# 查看包内容
tar -tzf yaoyuanchao-dingtalk-1.2.0.tgz

# Git 操作
git status
git log --oneline -10
git diff
git add .
git commit -m "feat: new feature description"

# 推送到 GitHub（首次）
git push -u origin main
git push --tags
```

### 远端操作

```bash
# 连接远端
ssh clawd@172.20.90.45

# 备份远端配置
scp clawd@172.20.90.45:~/.clawdbot/clawdbot.json \
  ./backup/remote-config-$(date +%Y%m%d).json

# 备份远端插件代码
scp -r clawd@172.20.90.45:~/.clawdbot/extensions/dingtalk \
  ./backup/remote-plugin-$(date +%Y%m%d)

# 查看远端插件状态
ssh clawd@172.20.90.45 "clawdbot plugins list | grep dingtalk"

# 查看远端日志
ssh clawd@172.20.90.45 "tail -f /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log | grep dingtalk"

# 重启 Gateway
ssh clawd@172.20.90.45 "pkill -f 'clawdbot gateway' && nohup clawdbot gateway > /dev/null 2>&1 &"

# 测试健康检查
ssh clawd@172.20.90.45 "clawdbot status --deep"
```

### 插件管理

```bash
# 安装插件
clawdbot plugins install @yaoyuanchao/dingtalk

# 列出插件
clawdbot plugins list

# 更新插件
clawdbot plugins update @yaoyuanchao/dingtalk

# 卸载插件
clawdbot plugins uninstall dingtalk

# 配置向导
clawdbot onboard --channel dingtalk

# 健康检查
clawdbot doctor
clawdbot status --deep

# 启动 Gateway
clawdbot gateway
```

---

## 📊 项目完成度和状态

### ✅ 已完成的工作

**Phase 1: MVP（必须实现）**
- [x] Package.json 改造（NPM 配置）
- [x] Zod 配置验证（config-schema.ts）
- [x] 交互式 Onboarding（onboarding.ts）
- [x] 健康检查（probe.ts）
- [x] 文档更新（README、CHANGELOG、LICENSE）

**Phase 2: 测试和发布**
- [x] 本地打包测试
- [x] NPM 发布
- [x] 远端安装验证
- [x] Gateway 测试通过
- [x] 消息收发验证

**Phase 3: 兼容性和问题修复**
- [x] 修复 richtext messageFormat 支持（commit 173e9fb）
- [x] 权限问题解决方案（EACCES）
- [x] 配置验证失败解决方案
- [x] 完整兼容性文档（COMPATIBILITY.md）
- [x] 安装问题分析（INSTALLATION-ISSUES.md）

**Phase 4: 用户升级方案**
- [x] 一键升级脚本（upgrade-from-v0.1.0.sh）
- [x] 三层升级文档（分享给老用户.md、QUICK-UPGRADE.md、UPGRADE.md）
- [x] 升级方案总结
- [x] 不依赖 GitHub 的分发方案（4 种方式）

### 🔄 待完成的工作

**推送到 GitHub**
- [ ] `git push -u origin main`
- [ ] `git push --tags`
- [ ] 验证所有 GitHub 链接可访问

**可选增强**
- [ ] 单元测试（monitor.ts、api.ts 等）
- [ ] CI/CD 配置（GitHub Actions）
- [ ] 自动化发布流程
- [ ] 更多测试用例

---

## 📝 已知问题和解决方案

### Issue 1: messageFormat richtext 兼容性
**问题**: Zod schema 最初只支持 'text' 和 'markdown'，但旧配置使用 'richtext'
**解决**: 添加 'richtext' 到 enum，作为 markdown 的 deprecated 别名
**Commit**: 173e9fb

### Issue 2: NPM 权限错误 (EACCES)
**问题**: extensions 目录不存在或权限不对
**影响**: 从 root 安装 v0.1.0 然后升级的用户
**解决**:
```bash
mkdir -p ~/.clawdbot/extensions
chown -R clawd:clawd ~/.clawdbot/extensions
```

### Issue 3: 配置验证失败
**问题**: 删除旧插件后，配置中的 dingtalk 引用导致验证失败
**影响**: 所有升级用户
**解决**: 升级脚本自动清理配置引用，安装后再恢复

### Issue 4: GitHub 链接 404
**问题**: 文档中的 GitHub raw 链接无法访问（代码未推送）
**影响**: 使用一键升级脚本的用户
**解决**: 提供 4 种不依赖 GitHub 的分发方案（见 `实际可用的分享方案.md`）

---

## 🎯 用户升级方案汇总

### 最推荐：方案 3（直接 NPM 安装）

**给用户的完整步骤**（复制粘贴即可）:
```bash
# 1. 备份配置
cp ~/.clawdbot/clawdbot.json ~/.clawdbot/clawdbot.json.backup-$(date +%Y%m%d)

# 2. 删除旧版本并安装新版本
rm -rf ~/.clawdbot/extensions/dingtalk && \
clawdbot plugins install @yaoyuanchao/dingtalk

# 3. 手动恢复配置
# 编辑 ~/.clawdbot/clawdbot.json
# 从备份文件复制 channels.dingtalk 配置回来
# 添加 plugins.entries.dingtalk: {"enabled": true}

# 4. 启动
clawdbot gateway
```

### 其他方案

**方案 1: 一键升级脚本（需要 GitHub 或内网服务器）**
```bash
curl -fsSL https://raw.githubusercontent.com/akedia/dingtalkclawd/main/upgrade-from-v0.1.0.sh | bash
# 或
curl -fsSL http://172.20.90.45/upgrade-from-v0.1.0.sh | bash
```

**方案 2: 打包分享**
```bash
# 创建分享包
cd e:\dingtalkclawd
tar czf dingtalk-upgrade-kit.tar.gz \
  upgrade-from-v0.1.0.sh \
  分享给老用户.md \
  QUICK-UPGRADE.md \
  UPGRADE.md \
  COMPATIBILITY.md

# 发给用户，用户解压后运行
tar xzf dingtalk-upgrade-kit.tar.gz
bash upgrade-from-v0.1.0.sh
```

**方案 4: 推送 GitHub 后（长期方案）**
```bash
# 推送后所有 GitHub 链接生效
git push -u origin main
git push --tags
```

---

## 🔍 故障排查

### 插件安装失败
```bash
# 检查插件目录权限
ls -ld ~/.clawdbot/extensions
# 应该是: drwxr-xr-x clawd clawd

# 修复权限
mkdir -p ~/.clawdbot/extensions
chown -R clawd:clawd ~/.clawdbot/extensions

# 重新安装
clawdbot plugins install @yaoyuanchao/dingtalk
```

### 配置验证失败
```bash
# 查看详细错误
clawdbot doctor

# 检查配置格式
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk'

# 运行配置向导重新配置
clawdbot onboard --channel dingtalk
```

### Gateway 无法连接
```bash
# 查看日志
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep dingtalk

# 测试健康检查
clawdbot status --deep

# 检查凭证
echo $DINGTALK_CLIENT_ID
echo $DINGTALK_CLIENT_SECRET

# 重启 Gateway
pkill -f "clawdbot gateway"
clawdbot gateway
```

### 消息收不到
```bash
# 检查白名单
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk.dm.allowFrom'
cat ~/.clawdbot/clawdbot.json | jq '.channels.dingtalk.groupAllowlist'

# 检查日志中的 staffId 和 conversationId
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep -E "staffId|conversationId"

# Pairing 模式：查看日志中显示的 staffId，添加到白名单
# 群聊：查看日志中显示的 conversationId，添加到 groupAllowlist
```

---

## 📚 相关资源

### 文档链接
- **README**: [README.md](../README.md) - 项目主说明
- **CHANGELOG**: [CHANGELOG.md](../CHANGELOG.md) - 版本变更历史
- **UPGRADE**: [UPGRADE.md](../UPGRADE.md) - 详细升级指南
- **COMPATIBILITY**: [COMPATIBILITY.md](../COMPATIBILITY.md) - 兼容性说明

### NPM 和 GitHub
- **NPM 包**: https://www.npmjs.com/package/@yaoyuanchao/dingtalk
- **GitHub 仓库**: https://github.com/akedia/dingtalk-clawdbot (代码未推送)
- **参考项目**: https://github.com/m1heng/clawdbot-feishu

### DingTalk 开发者资源
- **开发者平台**: https://open-dev.dingtalk.com/
- **Stream SDK 文档**: https://open.dingtalk.com/document/orgapp/stream-overview
- **API 参考**: https://open.dingtalk.com/document/orgapp-server/api-overview

### Clawdbot 文档
- **插件开发**: https://github.com/clawdbot/clawdbot (需要确认)
- **Zod 文档**: https://zod.dev/

---

## 🎉 总结

### 项目成就
✅ 成功将手动安装插件改造为官方 NPM 插件
✅ 100% 向后兼容 v0.1.0 配置
✅ 添加 Zod 类型安全验证
✅ 提供交互式配置向导
✅ 实现健康检查功能
✅ 创建完整的三层升级文档
✅ 提供一键升级脚本
✅ 远端生产环境测试通过

### 核心优势
- **官方化**: 支持 `clawdbot plugins install` 标准安装
- **类型安全**: Zod 验证提供详细错误提示
- **用户友好**: Onboarding 向导降低配置门槛
- **可维护性**: 健康检查和探测功能
- **兼容性**: 完全兼容旧版本配置
- **文档完善**: 三层升级指南覆盖所有用户

### 下一步建议
1. 推送代码到 GitHub（激活所有文档链接）
2. 选择合适的分发方式通知老用户
3. 收集用户反馈，迭代改进
4. 考虑添加单元测试
5. 设置 CI/CD 自动化发布

---

**最后更新**: 2026-01-28
**维护者**: yaoyuanchao
**Claude Code Session**: e:\agentsdkwebui → e:\dingtalkclawd
