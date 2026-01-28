# .claude 目录 - 项目文档中心

> 这个目录包含了 DingTalk Clawdbot Plugin 项目的完整认知和开发文档

---

## 📚 文档索引

### 🎯 核心文档（必读）

**[CLAUDE.md](./CLAUDE.md)** - 项目完整认知文档
- 项目概述和当前状态
- 远端服务器信息（172.20.90.45）
- 目录结构和文件说明
- Git 和 NPM 发布信息
- 已完成的工作和待办事项
- 已知问题和解决方案
- 用户升级方案汇总

👉 **新 session 必读！** 包含恢复上下文所需的所有信息。

---

### ⚡ 快速参考

**[QUICK-REFERENCE.md](./QUICK-REFERENCE.md)** - 常用命令速查表
- 远端服务器连接
- 重要路径速查
- 常用操作（一键复制）
- 故障排查命令
- 日志分析
- 快速部署流程
- 配置模板

👉 **开发必备！** 所有常用命令都在这里。

---

### 🔧 开发指南

**[DEVELOPMENT.md](./DEVELOPMENT.md)** - 技术细节和架构
- 插件架构概览
- 核心模块详解（配置验证、访问控制、消息发送等）
- 关键技术决策
- 测试策略
- 代码规范
- 版本管理
- 发布流程
- 调试技巧

👉 **深入开发必读！** 理解项目架构和技术决策。

---

## 🗂️ 文档使用指南

### 场景 1: 新开一个 Claude Code Session

1. 打开 `e:\dingtalkclawd` 目录
2. 启动 Claude Code
3. 阅读 [CLAUDE.md](./CLAUDE.md) 恢复完整上下文
4. 参考 [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) 执行常用操作

### 场景 2: 需要执行远端操作

直接查看 [QUICK-REFERENCE.md](./QUICK-REFERENCE.md)，复制粘贴命令即可。

### 场景 3: 开发新功能或修复 Bug

1. 阅读 [DEVELOPMENT.md](./DEVELOPMENT.md) 理解架构
2. 查看相关源码文件（参考架构图）
3. 遵循代码规范编写代码
4. 参考发布流程发布新版本

### 场景 4: 故障排查

1. 查看 [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) 的故障排查部分
2. 查看 [CLAUDE.md](./CLAUDE.md) 的已知问题部分
3. 查看 [../INSTALLATION-ISSUES.md](../INSTALLATION-ISSUES.md) 了解常见安装问题

---

## 📋 项目文档全景

```
e:\dingtalkclawd\
├── .claude\                        # 项目认知文档（当前目录）
│   ├── README.md                   # 本文档（文档索引）
│   ├── CLAUDE.md                   # 完整项目认知（必读）
│   ├── QUICK-REFERENCE.md          # 常用命令速查表
│   └── DEVELOPMENT.md              # 开发指南和架构
│
├── README.md                       # 项目主说明（面向用户）
├── CHANGELOG.md                    # 版本变更历史
├── LICENSE                         # MIT 许可证
│
├── UPGRADE.md                      # 详细升级指南（7 步）
├── QUICK-UPGRADE.md                # 快速升级指南（3 步）
├── COMPATIBILITY.md                # 配置兼容性说明
├── INSTALLATION-ISSUES.md          # 安装问题分析
├── DEPLOYMENT-SUMMARY.md           # 部署总结
│
├── 分享给老用户.md                  # 用户友好升级通知
├── 给用户的升级方案总结.md           # 升级方案完整总结
├── 实际可用的分享方案.md             # 不依赖 GitHub 的分发方案
│
├── upgrade-from-v0.1.0.sh          # 一键升级脚本
│
├── package.json                    # NPM 包配置
├── index.ts                        # 插件入口
└── src\                            # 源代码
    ├── channel.ts                  # ChannelPlugin 实现
    ├── monitor.ts                  # Stream 监听
    ├── api.ts                      # DingTalk API 封装
    ├── accounts.ts                 # 账户配置解析
    ├── config-schema.ts            # Zod 配置验证
    ├── onboarding.ts               # 交互式配置向导
    ├── probe.ts                    # 健康检查
    ├── types.ts                    # TypeScript 类型
    └── runtime.ts                  # Runtime 引用
```

---

## 🎯 快速上手

### 1️⃣ 恢复完整上下文
```bash
cd e:\dingtalkclawd
cat .claude\CLAUDE.md
```

### 2️⃣ 查看远端状态
```bash
ssh root@172.20.90.45 "su - clawd -c 'clawdbot plugins list | grep dingtalk'"
ssh root@172.20.90.45 "ps aux | grep 'clawdbot gateway'"
```

### 3️⃣ 本地开发
```bash
cd e:\dingtalkclawd
git status
npm pack
```

### 4️⃣ 发布更新
```bash
npm publish --access public
ssh root@172.20.90.45 "su - clawd -c 'clawdbot plugins update @yaoyuanchao/dingtalk'"
```

---

## 🔗 外部链接

- **NPM 包**: https://www.npmjs.com/package/@yaoyuanchao/dingtalk
- **GitHub 仓库**: https://github.com/akedia/dingtalk-clawdbot
- **参考项目**: https://github.com/m1heng/clawdbot-feishu
- **DingTalk 开发者平台**: https://open-dev.dingtalk.com/

---

## 💡 提示

### 保持文档同步
当项目发生重大变更时，记得更新相关文档：
- 新功能 → 更新 CLAUDE.md 和 DEVELOPMENT.md
- 新命令 → 更新 QUICK-REFERENCE.md
- 架构变更 → 更新 DEVELOPMENT.md
- 配置变更 → 更新所有相关文档

### 使用场景映射
| 你想做什么 | 查看哪个文档 |
|-----------|------------|
| 了解项目全貌 | [CLAUDE.md](./CLAUDE.md) |
| 执行远端操作 | [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) |
| 深入开发功能 | [DEVELOPMENT.md](./DEVELOPMENT.md) |
| 排查问题 | [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) + [CLAUDE.md](./CLAUDE.md) |
| 发布新版本 | [DEVELOPMENT.md](./DEVELOPMENT.md) 的发布流程 |

---

**最后更新**: 2026-01-28
**文档维护者**: Claude Code (with yaoyuanchao)
