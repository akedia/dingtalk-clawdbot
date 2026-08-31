# DingTalk Clawdbot Plugin

> DingTalk Channel Plugin for ClawdBot/OpenClaw（`@yaoyuanchao/dingtalk` v1.7.12）

## 状态

- ✅ OpenClaw 2026.8.1 升级（2026-08-31，事故驱动）— DingTalk agent（Jax）受用户指示自行升级但迁移没跑完导致 ~2h 停机，恢复过程踩了 5 道 fail-closed 关卡，详见升级记录
- ✅ OpenClaw 2026.7.1 升级（2026-07-15）— Node 22.23.1、插件收敛要求编译产物（dist/index.js 打包 + npm 目录 symlink 领养）、部署流程新增 build 步骤，详见升级记录
- ✅ OpenClaw 2026.5.18 升级（2026-05-20）— Discord/acpx/weixin 外部化、Bedrock 清理、Discord READY 超时调优、bootstrap 文件大瘦身、orphan session 归档 1.25 GB，详见升级记录
- ✅ OpenClaw 2026.4.22 升级（2026-04-24）— 修复 reply dispatcher 流式末尾重复发送，详见升级记录
- 🔄 待办: 单元测试、CI/CD

## 快速参考

| 信息 | 值 |
|------|-----|
| NPM 包 | `@yaoyuanchao/dingtalk` v1.7.13（npm 上仍是 1.7.12 TS-only，待发布带 dist 的新版） |
| GitHub | https://github.com/akedia/dingtalk-clawdbot |
| 远端服务器 | `ssh root@172.20.90.45`，运行用户 `clawd` |
| Gateway 管理 | `openclaw gateway restart/stop/start/status` |
| 插件升级 | **不要用** `openclaw plugins update dingtalk`（会覆盖为 npm 版本），用 git pull；改 .ts 后**必须重新打包 dist**（见 deploy skill） |
| 模型 | `onehub-claude/claude-sonnet-5`（main/clawd2；agents 默认 `onehub-gemini/gemini-3.5-flash`，qiang 继承默认。via onehub，不需要代理） |
| OpenClaw 版本 | `2026.8.1`（2026-08-31 升级；Node 22.23.1） |
| 外部插件 | `@openclaw/discord@2026.8.1` / `@openclaw/acpx@2026.8.1` / `@tencent-weixin/openclaw-weixin@2.4.6`（weixin 尚不兼容 8.1，等上游适配） |
| Agent 列表 | `main`（Jax）、`qiang`（QiangBot）、`clawd2`（Clawd2）— 共享同一 runtime |
| 本地分支 | `master` |

## 详细文档

- **[docs/operations.md](../docs/operations.md)** — NPM 发布、Git 部署、故障排查、OpenClaw 升级流程、已知问题

## 核心代码速查

| 文件 | 职责 |
|------|------|
| `index.ts` | 插件入口，导出 plugin 对象 |
| `src/monitor.ts` | Stream 连接、消息收发、媒体下载、访问控制、SDK 管道 |
| `src/channel.ts` | ChannelPlugin 接口实现 |
| `src/config-schema.ts` | Zod 配置验证 schema |
| `src/accounts.ts` | 配置解析和环境变量 |
| `src/onboarding.ts` | 交互式配置向导 |
| `src/probe.ts` | 健康检查 |
| `src/api.ts` | DingTalk API 封装 |

## Architecture Knowledge

- 调试 API 集成（Vidu、fal.ai、DingTalk API 等）时，先记录完整错误响应体再提方案，不要仅凭状态码猜测根因
- 本插件运行在 Clawdbot/OpenClaw 的 Gateway 进程内，没有独立进程。重启 Gateway = 重启插件
- DingTalk Stream SDK（WebSocket 长连接）管理连接生命周期，非本插件直接管理
- **关键**: `startDingTalkMonitor()` 必须在 channel 运行期间保持 Promise pending。SDK 的 `connect()` 会立即 resolve（不等 WebSocket 打开），所以函数末尾用 `await abortSignal` 阻止提前返回。否则 OpenClaw 认为 channel "stopped"，触发无限 auto-restart 循环
- 各 API 服务（Vidu、fal.ai 等）是独立的外部服务，调试时要确认实际调用的是哪个端点

### 运行时配置

- **服务**：systemd user service `openclaw-gateway.service`（用户 `clawd`，UID 1001，端口 18789）
- **服务文件**：`/home/clawd/.config/systemd/user/openclaw-gateway.service`
- **入口**：`dist/index.js`（2026.2.23 以后从 `entry.js` 改过来的）
- **模型 provider**：`onehub-claude`（`baseUrl: https://onehub.tap4fun.com/claude`，`api: anthropic-messages`），走 onehub 网关，不需要代理
- **Sonnet 5 手动声明**（≤2026.6.11 catalog 不认识 sonnet-5 的兼容 hack）：provider 里手动定义 `claude-sonnet-5`（contextWindow 200000 / maxTokens 64000 / `params.canonicalModelId: "claude-sonnet-4-6"` 借用 4-6 的能力映射）。maxTokens 2026-07-14 从 16384 调到 64000（onehub 实测 128K 也接受；Sonnet 5 官方上限 1M context / 128K output）。OpenClaw 2026.7.1 起原生支持 Sonnet 5（PR #98254），升级后可评估简化/移除该手动定义

## Debugging Protocol

1. 诊断 API 错误：先获取并展示完整错误响应，再提修复方案
2. 不根据文档猜测 HTTP 错误原因——要验证实际请求/响应
3. 日志监控/异步任务：每 2-3 次检查汇总一次状态，不反复 dump 原始日志
4. 关联日志事件时始终验证 request ID——不假设最近事件属于当前跟踪任务
5. 使用 [docs/operations.md](../docs/operations.md) "查看 Gateway 日志"一节的 Python 格式化命令提取可读日志，不要 raw `tail`

## Change Management Rules

- 新功能默认创建为 STANDALONE 组件（独立 URL），除非明确要求集成到现有页面
- 架构变更（服务配置等）前先陈述对系统架构的理解，等用户确认后再动手
- 修复不成功后先 REVERT 再尝试其他方案，不要叠加修复
- 修改 `src/monitor.ts`（最大文件 600+ 行）时做定向修改，不要顺带重构周围代码

## 远端部署速查（Git 方式）

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

**注意**:
- 远端使用 **Git 部署**（非 npm），远程 agent 可自行修改代码并提交
- `su - clawd` 不建立 systemd 用户会话，必须注入 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS`
- **不要用** `openclaw plugins update dingtalk`（会覆盖为 npm 版本）
- 详见 [docs/operations.md](../docs/operations.md) 的 Git 部署章节

## 关键资源

- **OpenClaw 插件开发文档**: https://docs.openclaw.ai/plugin
- **OpenClaw CLI**: https://docs.openclaw.ai/cli
- **DingTalk Stream SDK**: https://open.dingtalk.com/document/orgapp/stream-overview
- **参考项目（飞书）**: https://github.com/m1heng/clawdbot-feishu
- **su + systemd 已知问题**: https://github.com/moltbot/moltbot/issues/1818

## 已知问题

### DingTalk Stream SDK
- `dingtalk-stream` v2.1.4（最新版，2024-03-21 发布，已停止维护）
- SDK 的 `_connect()` 创建 WebSocket 后立即 resolve，不等 `open` 事件 — 我们在 `startDingTalkMonitor()` 末尾用 `await abortSignal` 补偿
- SDK 内置 `autoReconnect: true`，断开 1 秒后自动重连，无退避
- OpenClaw health-monitor 每 5 分钟检查一次，检测到 `running: false` 会触发 auto-restart 循环（最多 10 次，指数退避）
- 日志里每 300s 左右出现一次 `Heartbeat timeout, forcing reconnect` 是正常的 — SDK 默认 idle 超时触发的保活重连，不代表异常

### OpenClaw 2026.8.1（当前版本）

- **5 道 fail-closed 启动关卡**（升级/迁移不完整时依次触发，全部会 crash-loop）：
  1. 配置 schema 严格校验：8 组 legacy 键直接拒启动（见升级记录的手动迁移清单）
  2. `agents.ownership`：多 agent roster 必须显式 `agents.ownership: "explicit"`（或恰好一个 `default: true`），否则 doctor 拒绝写盘迁移
  3. legacy session store：任何 agent 目录下存在 `sessions/sessions.json` 即拒启动（含非 roster 的旧目录）；导入用 `openclaw doctor --session-sqlite import --session-sqlite-agent <id>`，导入后**残留源文件必须归档**（文件存在本身就触发关卡）
  4. 插件能力同意：所有插件需 `openclaw plugins enable <id> --accept-capabilities` 重新授权，否则插件挂载但 channel 不激活（表现为 `configured: false`）
  5. legacy exec approvals：`~/.openclaw/exec-approvals.json` 存在时 Discord 等 channel 循环退出；doctor 非交互模式不迁移，无实质数据时直接归档。**注意：此文件存在还会连坐阻塞 doctor 后续所有迁移**（workspace/auth-profile 等全部跳过且 exit 1）——归档它之后 doctor 才第一次干净跑完
  6. legacy workspace setup state：`<workspace>/.openclaw/workspace-state.json`（70 字节 bootstrap 种子标记）存在时**消息 dispatch 直接失败**（"思考中"占位发出后立即撤回）、cron tick 每 2 秒报错——网关能起、Stream 能连，但 agent 无法回复，最隐蔽的一道。doctor 干净跑完后会迁移+删除，但已验证过 SQLite 的 workspace 可能残留源文件（又是 7.1 的残留模式），需手动归档
- **doctor 的坑**：`--fix --non-interactive` 只跑 "safe migrations"，**不写配置迁移**（探测出 legacy 键但让你"再跑 doctor --fix"死循环）；gateway 运行时跑 doctor 会因 maintenance lease 竞争跳过 SQLite 迁移——必须先 stop 服务再跑；配置手动迁移后用 `openclaw gateway status`（只读校验器）验证
- **restart-loop breaker**：5 分钟窗口内多次 unclean boot 会压制 channel 自动启动，即使后续启动成功；等窗口过后干净重启一次即恢复
- weixin 2.4.6 仍 import 已移除的 `./plugin-sdk/channel-runtime` → channel 起不来（重试 10 次后停），等上游发 8.1 适配版
- 遗留：memory-core "dreaming cron reconcile failed: Agent-less cron job" 需设 `agents.defaults.systemAgent.agentId`（每 tick 报 WARN，无功能影响）。qiang/clawd2 auth-profiles 与 `agents.list → entries` 均已在恢复过程中完成迁移

### OpenClaw 2026.7.1（历史）

- **插件必须有编译产物**：plugin convergence 在 gateway readiness 前运行，TS-only entry 会被拒。本插件入口是 `dist/index.js`（esbuild bundle，见 deploy skill 的 build 步骤）；**服务器上直接改 .ts 不再生效**
- **npm 目录 symlink 不能动**：`~/.openclaw/npm/node_modules/@yaoyuanchao/dingtalk` → git checkout 的软链，是收敛"领养"安装记录的依据
- **迁移 fail-closed**：任何 legacy state 迁移警告都会让 gateway 拒绝 ready 并 crash-loop，恢复路径是 `doctor --fix` / 归档冲突的 legacy 文件
- Node 要求 ≥22.22.3 <23 或 ≥24.15.0（当前 22.23.1，nodesource deb）

### OpenClaw 2026.5.18（历史）
- `openclaw doctor --fix` 可能向 channel 配置注入平台级键（如 `allowFrom`、`dmPolicy`），插件 Zod schema 用 `.passthrough()` 兼容；升级后必须 backup vs current 完整 diff
- **5.x 起 Discord/acpx/weixin 已外部化**：需 `openclaw plugins install @openclaw/discord` / `@openclaw/acpx` / `@tencent-weixin/openclaw-weixin@2.4.3` 单独装
- **Discord channel** 必须配 `gatewayReadyTimeoutMs: 45000`（默认 15000 在 event loop 饱和时不够；2026-05-20 实测踩坑）
- `plugins.allow` 已被 `plugins.bundledDiscovery` 替代（`doctor --fix` 自动迁移为 `"compat"`）
- LAN 绑定的 gateway 需要 `gateway.controlUi.allowedOrigins` 或 `dangerouslyAllowHostHeaderOriginFallback: true`（2026.2.23 起要求）

## 升级记录

### 2026-08-31: OpenClaw 2026.7.1 → 2026.8.1（计划外，服务中断 ~2h，agent 自主升级事故）

**事故经过**：用户在钉钉给 main agent（Jax）发了 OpenClaw 2.0 博客并说"来吧，升级"。Jax 16:58 执行 `npm install -g openclaw@2026.8.1`，随后 `doctor --fix` 连续两次被 OOM SIGKILL（gateway ~870MB + grfal ~1.8GB 吃满内存）、迁移未完成，Jax 误判"不影响运行"宣布收工并重启 gateway → 17:02 起 crash-loop（exit 78 EX_CONFIG），三个钉钉 bot + Discord 全部离线。用户 ~17:15 发现 bot 失联。恢复至 19:13 全部 channel 重连。

**恢复步骤**（每步都撞一道新 fail-closed 关卡，全列表见"已知问题 2026.8.1"）：
1. stop 服务止住 crash-loop、释放内存（doctor 不再 OOM）
2. 手动加 `agents.ownership: "explicit"`（doctor 死结：迁移候选校验失败就拒绝写盘，而缺的键它又不肯自己加）
3. **手动迁移 8 组 legacy 配置键**（doctor --fix 非交互模式不写配置）：`meta.lastTouchedAt` 删；`env` 自定义变量 → `env.vars.*`；`browser.profiles.chrome.color` 删；`agents.defaults.imageGenerationModel` → `mediaModels.image`；`agents.defaults.memorySearch` → `memory.search`（其中 `query.hybrid`、`cache.maxEntries` 已退役需删）；`commands.ownerDisplay` 删；`gateway.controlUi.allowInsecureAuth` 删；`memory.backend` 删、`memory.qmd.paths` → `memory.search.extraPaths`（字符串数组）；`plugins.bundledDiscovery` 删（doctor 已迁 SQLite）。迁移规则全部对照 `dist/legacy-pGW3ZP3t.js` 源码，用 `openclaw gateway status` 只读校验
4. 逐 agent 跑 `doctor --session-sqlite import --session-sqlite-agent <main|qiang|clawd2>`，归档残留 `sessions.json`（含旧 claude/claude-code/codex 目录的）
5. 四个插件 `plugins enable <id> --accept-capabilities` 重新授权（8.1 新要求，不授权 channel 不激活）
6. discord/acpx 更到 2026.8.1、weixin 更到 2.4.6（仍不兼容，等上游）
7. 归档空的 legacy `exec-approvals.json`（Discord channel 循环退出的原因，且它连坐阻塞 doctor 全部后续迁移）
8. 用户实测发现第 6 道关卡：Stream 连着但消息 dispatch 失败（"思考中"发出即撤回）——`workspace-state.json` 未迁移。归档 exec-approvals 后离线 doctor 首次干净跑完（qiang/clawd2 workspace + auth-profiles 全部入 SQLite、SECRETS_DEGRADED 消失），main 的 workspace-state.json 残留手动归档
9. 用户二次实测仍秒撤回：`PreparedModelCatalogConfigReplacedError`——在迁移半完成状态下启动的 gateway，其模型 runtime 快照已被污染，边跑边归档修不好。**所有迁移全部完成后必须再干净重启一次**，重启后用 `openclaw agent --agent <id> --message '...'` 走真实 Gateway agent turn 验证（比看 Stream connected / cron 无错可靠——那两个绿了 dispatch 仍可能是坏的），三个 agent 全部返回 OK 才算恢复

**教训**：
- **无人值守升级必须有契约**：Jax 在 doctor 两次 SIGKILL、迁移明确未完成的情况下仍宣布"升级收工"并重启——正确行为是停在那里等人。远程 agent 的 prompt 里要有"迁移工具异常退出 = 暂停等人"的停止条件
- Jax 的 bootstrap 记忆还停在 2026.5.18（实际 7.1），版本认知过期加剧误判；升级这类操作 agent 应先核实实际版本
- doctor 被 OOM 杀 ≠ 可以跳过：8.1 的迁移是 fail-closed 前置条件，跑不完 gateway 就起不来
- 大版本（"2.0"重构版）升级前依然要走 breaking-changes 审查流程，这次完全没做

**升级收益**：Discord/acpx 插件同步到 8.1；session store 全量入 SQLite（main 归档了 15378 个无引用 jsonl，clawd2 压缩回收 81MB）；配置清理干净了多年积累的 legacy 键
**遗留事项**：weixin channel 等上游适配 8.1（2.4.6 仍 import 已移除的 SDK 导出）；memory-core dreaming cron 的 agent-less job 警告（需设 `agents.defaults.systemAgent.agentId`）；npm 发布 1.7.13 仍未做。qiang/clawd2 凭证迁移和 agents.entries 迁移已在恢复中完成

### 2026-07-15: OpenClaw 2026.6.11 → 2026.7.1（含服务中断 ~1.5h，教训多）

**触发原因**：获得 Sonnet 5 原生 catalog 支持（PR #98254）等。前一天已完成风险评估 + maxTokens 调优（16384→64000）。

**连环踩坑与修复**（按时间序）：
1. **Node engine 硬拦**：7.1 要求 node ≥22.22.3，服务器 22.22.0（nodesource deb）。npm install 只警告不阻断，但 CLI/gateway 硬拒启动 → `apt-get install nodejs` 升到 22.23.1。**教训：npm install -g 完成 ≠ 升级完成，中间态下网关一旦重启就起不来，动手前先核对 engine 要求**
2. **fail-closed 迁移**：7.1 起状态迁移在 gateway readiness 之前跑，任何 legacy 迁移警告都拒绝 ready 并 crash-loop。踩中 `memory/.dreams/short-term-recall.json`（SQLite 已有数据、导入跳过、源文件残留）→ 归档到 `~/clawd/.archive/memory-dreams-2026-07-15/` 解决
3. **插件收敛（plugin convergence）是本次最大坑**：7.1 在 readiness 前对每个"已配置但无安装记录"的插件执行自动安装修复。DingTalk 是 git checkout、从无安装记录 → 收敛从 ClawHub/npm 下载 1.7.12（TS-only）→ 撞新规则"包安装必须有编译产物"→ fail-closed 死循环。**试过无效的**：plugins.load.paths 注册、删 plugins.entries.dingtalk、manifest 改 defaultChoice=local、删 manifest install 块（spec 来自持久化快照不是活 manifest）。**最终解法（两件套）**：
   - 仓库改为携带编译产物：esbuild 打包 `dist/index.js`（ESM bundle，dingtalk-stream/zod external），`openclaw.extensions` 指向它（commit 5b4672f）
   - `ln -s ~/.openclaw/extensions/dingtalk ~/.openclaw/npm/node_modules/@yaoyuanchao/dingtalk` — 收敛的 adoptExistingNpmPackage 路径直接领养现有包生成安装记录，不再下载
4. **dist 化的连带后果**：服务器上曾有一处未提交的 jiti 热修（quoted-file spaceId 响应结构适配）在切换到 dist 后失效 → 已收进仓库并重新打包（0e94b96 + 02b8aa2）。**教训：切 dist 后服务器改 .ts 无效，所有修改必须走本地 build + git 部署**
5. doctor --fix 顺带迁移了三个 agent 的 auth-profiles JSON → SQLite（有 .bak 备份）；acpx/discord 从 2026.5.18 更新到 2026.7.1

**升级收益**：Sonnet 5/Mythos 5 原生 catalog、崩溃循环保护（EX_CONFIG + control-plane-safe mode）、大量 channel/dispatcher 修复
**遗留事项**：npm 发布 1.7.13（带 dist，让收敛的 npm 路径也能成功）；`canonicalModelId` hack 可评估移除；service 文件仍是 2026.3.13 生成（doctor 建议 --repair）；memory search provider=openai 缺 API key 警告

### 2026-05-20: OpenClaw 2026.4.22 → 2026.5.18 + 大扫除

**触发原因**：用户问"线上 clawdbot 瓜了吗"。一查发现两个非致命问题：Discord channel 启动时 `Cannot find package 'openclaw'`（4.22 packaging 缺陷），以及 `bedrock-discovery` 启动 warn（AWS key 失效）。一并升级清理。

**Breaking changes 验证**（`npm pack openclaw@2026.5.18` 提取 CHANGELOG）：
- **4.24**：`api.registerEmbeddedExtensionFactory(...)` 移除 → DingTalk 插件没用 ✅
- **5.12**：Proxyline 替换内部 proxy → 用 onehub 直连不走 proxy ✅
- **5.12**：iMessage BlueBubbles 移除 → 不用 ✅

**操作步骤**：
1. 备份 `openclaw.json.pre-2026.5.18.bak`
2. 从 `openclaw.json` 删除 `models.providers.amazon-bedrock` + `env.AWS_ACCESS_KEY_ID/SECRET/REGION` 失效凭证
3. `npm install -g openclaw@2026.5.18`（54 added / 139 removed / 307 changed）
4. `openclaw plugins install @openclaw/discord`（5.x 拆离）→ symlink 自动指回全局 openclaw，包路径问题彻底修复
5. 配置 `channels.discord.gatewayReadyTimeoutMs: 45000` —— 启动 READY 超时根因是 event loop 饱和（126 命令注册 + bootstrap 文件加载）阻塞 callback，不是 GFW
6. 同时安装 `@openclaw/acpx` + `@tencent-weixin/openclaw-weixin@2.4.3`，把旧的 `~/.openclaw/extensions/openclaw-weixin/` 移到 `.archive/` 消除 duplicate warn
7. 清理 systemd service 文件里硬编码的 AWS env vars（3 行）
8. 给本仓库 `openclaw.plugin.json` + `clawdbot.plugin.json` 加 `channelConfigs` JSON schema（5.18 起 lint 要求），bump v1.7.12
9. `openclaw doctor --fix` 自动迁移 `plugins.allow` → `plugins.bundledDiscovery="compat"`
10. `openclaw tasks maintenance --apply`：9 task-flow reconcile + 48 prune，audit warnings 198→4
11. 归档 4755 个 orphan `.jsonl` session 文件（renamed to `.deleted.<ts>`，约 1.25 GB）
12. Bootstrap 文件大瘦身：USER.md / MEMORY.md / TOOLS.md 从 117 KB → 34 KB（71%↓），全部低于 12 KB truncation 限额；原文件归档在 `~/clawd/.archive/memory-2026-05-20/`

**踩到的坑**：
- 写 `channelConfigs` schema 时给 `groups.<cid>` 设了 `additionalProperties: false`，但实际配置里有 `name` 字段（Zod `.passthrough()` 历史允许）→ gateway 拒启动。修复：改 `additionalProperties: true` + 显式声明 `name`（commit `7653bd6`）
- 装 `@openclaw/weixin` 后旧本地 `~/.openclaw/extensions/openclaw-weixin/` 仍被扫描造成 duplicate，必须**移到 `extensions/` 外**才生效

**升级收益**（累积 4.22 → 5.18）：
- 5.18 changelog 明确提到「**external runtime-dependency repair for packaged installs**」+「**Packaged installs: preserve package-root runtime dependencies**」—— 这就是 Discord packaging 问题的修复
- Telegram 错误消息丢失修复、Slack file redirect 修复、context engine for Codex sessions 等若干通道修复
- Plugin SDK 改进：`channelConfigs` 描述符让 setup UI 能在 runtime 加载前正确工作
- 启动时静态模型 catalog + lazy provider deps，启动更轻

### 2026-04-24: OpenClaw 2026.4.15 → 2026.4.22

**触发原因**：用户报告 clawd1 持续发重复消息（回复末尾的短句重复 3–4 次）

**根因定位**：
- 插件 `deliver` 回调每次被调用都有独立 `Pipeline deliver payload` 日志 — 每个 payload 都是 runtime 新 dispatch 的，**插件没在重发**
- `resolveDeliverText` 和 `deliverReply` (`src/monitor.ts:1975, 2029`) 无 retry 逻辑，确认是 OpenClaw runtime 侧发了重复 payload
- 4.15→4.22 CHANGELOG 中直接相关的 fix：
  - **#70243** Auto-reply/streaming: preserve streamed reply directives through chunk boundaries and phase-aware `final_answer` delivery
  - **#68111** Auto-reply/media: share one run-scoped reply media context, suppress duplicate media sends reliably
  - Channels/replay dedupe 标准化（DingTalk 作为第三方插件不在列表内，但插件本身没问题）
- 重复位置（回复末尾短句）完全符合 "phase-aware final_answer 阶段边界" 行为

**操作步骤**：
1. `npm install -g openclaw@2026.4.22`
2. `sudo -u clawd openclaw doctor` 验证无 breaking schema 问题
3. `openclaw gateway restart`
4. 验证 Stream 三账户（default/qiang/clawd2）重新连上

**升级收益**（累积 4.15→4.22）：
- 流式末尾重复 payload 修复（本次主要诉求）
- Streaming 模式下 reply directives（MEDIA、voice 等）不再在 chunk 边界丢失/泄露
- CLI-backed reply 运行时 WebChat 状态正确
- 大量 Telegram/Discord/Slack/Matrix 重复投递相关修复（DingTalk 未直接涉及但共用底层 dispatcher）

### 后续升级注意事项

1. **Breaking changes 检查**：每次升级前用 `npm pack openclaw@<version>` 提取 CHANGELOG.md，`grep -n '^### Breaking' CHANGELOG.md` 确认范围
2. **`openclaw doctor --fix` 后务必检查**：它可能向 channel 配置注入插件不认识的键，目前 `.passthrough()` 可兼容
3. **升级步骤**：`npm install -g openclaw@<version>` → `openclaw doctor`（检查输出）→ 必要时 `--fix` → 重启 gateway → 验证 channel 连接
4. **回滚方案**：升级前手动备份 `openclaw.json.pre-<version>.bak`；`openclaw.json.bak` 是 doctor 自动创建的，可用于回滚配置

---
**最后更新**: 2026-08-31
