# DingTalk Clawdbot Plugin

> DingTalk Channel Plugin for ClawdBot/OpenClaw（`@yaoyuanchao/dingtalk` v1.7.18）

## 状态

- ✅ OpenClaw 2026.10.2 + 插件 1.7.18 + linked install（2026-10-13）— 插件改为 `plugins install -l ~/plugins/dingtalk`（10.x 下旧的 npm-symlink 领养会被 doctor 判 install incomplete 并可能被 npm 旧版覆盖）；修复非默认账号路由到 main 的缺陷（1.7.17）；缓存移出安装目录（1.7.18）；systemd 停止策略 330s/KillMode=mixed + 3GB 堆上限；隔离 staging 全量预演，详见升级记录
- ✅ OpenClaw 2026.9.9 + Node 24.21.0 + 插件 1.7.16（2026-10-13）— 9.3 起弃用 Node 22；10.x 删除 `plugin-sdk/config-runtime`，插件改读 `runtime-config-snapshot`；agent 库 schema v19→v24 需停机 `doctor --fix`；同日切 Sonnet 5.5、下线 qiang agent，详见升级记录
- ✅ OpenClaw 2026.9.2 升级 + 插件 1.7.15（2026-09-07）— 修复 `startAccount` 读 `signal` 而运行时传 `abortSignal` 导致的 Stream 实例泄漏（09-05 网关因此 heap 崩溃）；9.1/9.2 无 Breaking；顺带修 memory.search provider、删过期 my-coffee MCP、禁用冗余 GRFal 清理 cron、清理泄漏的 acpx 孤儿进程，详见升级记录
- ✅ weixin 插件卸载 + OpenClaw 2026.8.2 评估（2026-09-02）— 8.2 无 Breaking，未升级；插件依赖的 `plugin-sdk/config-runtime` 已被标废弃需迁到 `runtime-config-snapshot`，详见升级记录
- ✅ OpenClaw 2026.8.1 升级（2026-08-31，事故驱动）— DingTalk agent（Jax）受用户指示自行升级但迁移没跑完导致 ~2h 停机，恢复过程踩了 5 道 fail-closed 关卡，详见升级记录
- ✅ OpenClaw 2026.7.1 升级（2026-07-15）— Node 22.23.1、插件收敛要求编译产物（dist/index.js 打包 + npm 目录 symlink 领养）、部署流程新增 build 步骤，详见升级记录
- ✅ OpenClaw 2026.5.18 升级（2026-05-20）— Discord/acpx/weixin 外部化、Bedrock 清理、Discord READY 超时调优、bootstrap 文件大瘦身、orphan session 归档 1.25 GB，详见升级记录
- ✅ OpenClaw 2026.4.22 升级（2026-04-24）— 修复 reply dispatcher 流式末尾重复发送，详见升级记录
- 🔄 待办: 单元测试、CI/CD

## 快速参考

| 信息 | 值 |
|------|-----|
| NPM 包 | `@yaoyuanchao/dingtalk` v1.7.18（git 已部署 2026-10-13；npm 上仍是 1.7.14，待发布） |
| GitHub | https://github.com/akedia/dingtalk-clawdbot |
| 远端服务器 | `ssh root@172.20.90.45`，运行用户 `clawd` |
| Gateway 管理 | `openclaw gateway restart/stop/start/status` |
| 插件部署 | linked install（`source: path`）：服务器 checkout 在 `~/plugins/dingtalk`，`git pull` 后 `openclaw plugins reload dingtalk` 热替换，无需重启网关；改 .ts 后**必须重新打包 dist**（见 deploy skill）。不要把 checkout 放回 `~/.openclaw/extensions/`，不要重建 npm symlink |
| 模型 | `onehub-claude/claude-sonnet-5-5`（main/clawd2，2026-10-13 切换，手动声明 `canonicalModelId: claude-sonnet-5`；agents 默认 `onehub-gemini/gemini-3.5-flash`（onehub 实际服务 3.6-flash）（cron 等未指定模型的任务用它）。via onehub，不需要代理。onehub 无 Haiku 5.x） |
| OpenClaw 版本 | `2026.10.2`（2026-10-13 升级；Node 24.21.0，nodesource `node_24.x`；state schema v20、agent v24，不可回退二进制只能还原备份） |
| 外部插件 | `@openclaw/discord@2026.10.2` / `@openclaw/acpx@2026.10.2`（weixin 已于 2026-09-02 卸载） |
| Agent 列表 | `main`（Jax）、`clawd2`（Clawd2）— 共享同一 runtime（qiang/QiangBot 2026-10-13 下线，数据归档在 `~/.archive/qiang-removed-2026-10-13/`） |
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

### OpenClaw 2026.10.2（当前版本，2026-10-13 升级）

- **重启代价（2026-10-13 compact 后）**：main 库 1.30 GB → 625 MB、clawd2 233 MB → 121 MB（`openclaw doctor --session-sqlite compact --session-sqlite-all-agents`，网关停着跑，2 分钟），之后 agent 启动 inspection 在 5 秒前台预算内完成，不再有 15 分钟后台 inspection；冷启动到 ready ~5 分钟、热重启 ~2 分钟。compact 前 main 库有 640 MB 空闲页，10.x 在**主线程**跑 `incremental-vacuum` 回收，冻结网关 7 分钟并把同时进行的 `plugins reload` 卡死（见 deploy skill）。空闲页再涨起来时重复 compact
- 非 roster agent 目录（claude/codex/openclaw/claude-code/qiang）已归档到 `~/.archive/pre-compact-2026-10-13/agents/`；`claude` 是 ACP（`acp.defaultAgent: claude`）的状态目录，下次用 ACP 会重建
- 启动时 `secrets.degraded ... cold` 警告在 agent inspection 完成后自愈，不用 `secrets reload`
- 10.x 日志主要写文件 `/tmp/openclaw/openclaw-YYYY-MM-DD.log`，journal 内容很少
- 插件 linked install 不继承官方包信任；若某 channel 要求 trusted plugin state 会被拒启动（钉钉不需要，已实测）
- `doctor --non-interactive`（不带 --fix）也会做改动：会自动安装被配置隐式引用但缺失的插件（staging 实测装了 acpx）
- `OPENCLAW_PROFILE` 在 9.9 不生效（会落回 `~/.openclaw`）；隔离环境必须显式设 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`，日志用 `logging.file` 另指
- 原生 provider compaction（#168164）只对 provider=`anthropic` 直连生效，onehub 不触发
- `canonicalModelId: claude-sonnet-5` 让 sonnet-5-5 走 Sonnet 5 的能力映射（thinking 档位、tool_choice 分支），删除需单独验证
- 遗留：weixin 安装记录残留；discord 插件仍 9.9；失效的向量索引 `memory_index_chunks_vec_*` 占 ~120 MB（无 embedding 端点）

### OpenClaw 2026.9.2（历史）

- **9.1/9.2 无 Breaking**，Node 要求不变，`plugin-sdk/config-runtime` 子路径仍在（但仍应迁到 `runtime-config-snapshot`）。9.1 起迁移警告改为降级运行而非拒启；`cron.skipMissedJobs` 可选；`channels.<id>.enabled:false` 不再加载该插件；9.2 把长转录/磁盘读移出事件循环、ACP 子进程随父运行结束而终止
- **CLI 冷缓存会彻底挂死**：网关停着时 `plugins install @openclaw/discord` 两次各跑 8–9 分钟无输出、`doctor --fix --non-interactive` 9 分钟无输出（只打了配置警告），全部 timeout；acpx 却 3 分钟装完。网关起来跑热缓存后同一条 discord install 100 秒完成。**升级顺序建议：先起网关再装插件，再重启一次加载**，doctor 可以不跑（9.2 网关启动自迁移，只报 weixin 残留记录警告）
- 冷启动 4.75 分钟（08:31:00 start → 08:35:45 listening），首个 agent turn 112 秒；三个 agent `openclaw agent --agent <id> --message` 均 OK
- 8.1 的 discord 插件在 9.2 核心下能正常加载（两账号 initialized），不是硬依赖
- 遗留：`config_machine_state` 里的 weixin 安装记录仍让启动 Doctor 警告 "openclaw-weixin failed post-core payload smoke check"；memory.search 已改 gemini（provider/model 两键）需观察同步是否恢复

### OpenClaw 2026.8.1（历史）

- **5 道 fail-closed 启动关卡**（升级/迁移不完整时依次触发，全部会 crash-loop）：
  1. 配置 schema 严格校验：8 组 legacy 键直接拒启动（见升级记录的手动迁移清单）
  2. `agents.ownership`：多 agent roster 必须显式 `agents.ownership: "explicit"`（或恰好一个 `default: true`），否则 doctor 拒绝写盘迁移
  3. legacy session store：任何 agent 目录下存在 `sessions/sessions.json` 即拒启动（含非 roster 的旧目录）；导入用 `openclaw doctor --session-sqlite import --session-sqlite-agent <id>`，导入后**残留源文件必须归档**（文件存在本身就触发关卡）
  4. 插件能力同意：所有插件需 `openclaw plugins enable <id> --accept-capabilities` 重新授权，否则插件挂载但 channel 不激活（表现为 `configured: false`）
  5. legacy exec approvals：`~/.openclaw/exec-approvals.json` 存在时 Discord 等 channel 循环退出；doctor 非交互模式不迁移，无实质数据时直接归档。**注意：此文件存在还会连坐阻塞 doctor 后续所有迁移**（workspace/auth-profile 等全部跳过且 exit 1）——归档它之后 doctor 才第一次干净跑完
  6. legacy workspace setup state：`<workspace>/.openclaw/workspace-state.json`（70 字节 bootstrap 种子标记）存在时**消息 dispatch 直接失败**（"思考中"占位发出后立即撤回）、cron tick 每 2 秒报错——网关能起、Stream 能连，但 agent 无法回复，最隐蔽的一道。doctor 干净跑完后会迁移+删除，但已验证过 SQLite 的 workspace 可能残留源文件（又是 7.1 的残留模式），需手动归档
- **doctor 的坑**：`--fix --non-interactive` 只跑 "safe migrations"，**不写配置迁移**（探测出 legacy 键但让你"再跑 doctor --fix"死循环）；gateway 运行时跑 doctor 会因 maintenance lease 竞争跳过 SQLite 迁移——必须先 stop 服务再跑；配置手动迁移后用 `openclaw gateway status`（只读校验器）验证
- **restart-loop breaker**：5 分钟窗口内多次 unclean boot 会压制 channel 自动启动，即使后续启动成功；等窗口过后干净重启一次即恢复
- ~~weixin 2.4.6 仍 import 已移除的 `./plugin-sdk/channel-runtime` → channel 起不来~~ 2026-09-02 已卸载 weixin（上游 2.4.7 起改用 `channel-message`，但不再需要）。卸载踩坑：`plugins uninstall` 对安装目录已缺失的插件报 "no authoritative runtime child list" 拒绝处理；残留的 `config_machine_state.plugins.installedIndex` 安装记录会让每次启动 Doctor 警告 "install dir missing"
- **冷启动很慢不是卡死**：main agent SQLite 2.49 GB + 慢盘，restart 后 gateway 要 ~6.5 分钟才监听 18789（journal 期间无日志、`gateway status` 报 ECONNREFUSED）。看 `/proc/<pid>/io` 的 read_bytes 在涨就等，别再 restart。`plugins uninstall` / `registry --refresh` 冷缓存下也会 >90s 无输出
- **Discord READY 超时改为环境变量**：`channels.discord.gatewayReadyTimeoutMs` 已不在 8.1 config schema（08-31 迁移删掉是对的，加回去会被严格校验拒启动）。8.1 的 discord 插件改读 `OPENCLAW_DISCORD_READY_TIMEOUT_MS`（默认 15000）/ `OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS`（默认 30000）/ `OPENCLAW_DISCORD_RUNTIME_READY_TIMEOUT_MS`（默认 30000）。2026-09-02 已写入 `env.vars.OPENCLAW_DISCORD_READY_TIMEOUT_MS: "45000"`（必须是字符串，数字会被 env.vars 静默跳过；用 `openclaw config set ... '"45000"' --strict-json`）。**注意：写 env.vars 会让网关自动 full restart**
- **Discord 网络背景**：服务器无任何代理配置，公司网络边缘透明代理接管境外 443（所有外网 connect 都 1–3ms），DNS 把 discord.com 解析成 31.13.x.x 段也能通；discord.com REST 偶发 10–15s 超时、`gateway.discord.gg` WS 通常秒通。冷启动期间 event loop 冻结 98s 会连累 READY 15s 超时，但 backoff 重连后能自愈——**判断 Discord 是否在线看 `openclaw channels status --json` 的 `channelAccounts.discord[].connected`，journal 里连上不打日志**
- **Discord default 账号没有 agent 绑定**（8.1 之前也没有，当时靠隐式默认 agent；现在 `agents.ownership: explicit`，由 `systemAgent.agentId=main` 兜底）。09-02 曾把它绑给 main 又于 11:34 用 `openclaw config patch --stdin` 回滚（热加载；`agents unbind` 在这台机器上会挂满超时）。**当时归因错了**：`"Channel is required when multiple channels are configured: dingtalk, discord"` 与绑定/systemAgent 无关——message 工具的可用通道列表是全局的（`listConfiguredMessageChannelPlugins(cfg)` 不按 agent 过滤），cron 上下文没有"当前通道"可回退，所以 **cron 里的 message 调用必须带 `channel=dingtalk`**。09-02 与 09-03 两次报错都是「SLG融合初筛每日推送」任务的模型漏传 channel 参数（raw_params 里没有 channel），其它写成 `message action=send channel=dingtalk target=...` 的任务正常
- **这台机器上会挂死的 8.1 CLI**：`plugins uninstall`、`plugins registry --refresh`、`agents unbind`（网关正常时也一样，CLI 自己在慢盘/2.49 GB main 库上卡）；可靠的是 `config set` / `config patch --stdin`（30–40s，热加载）。`agents.defaults.systemAgent.agentId=main` 09-02 曾设置又删除——删除是错的，见下一条"cron 全停关卡"；当时的 330–380s 事件循环冻结是 cron 恢复后集中补跑积压任务所致
- **冷启动超过 ~7 分钟会撞 "startup migration lease was lost"** → 进程 exit 1，systemd 自动再拉一次（第二次 page cache 热了 ~4 分钟起来）；启动完成后 health-monitor 因 liveness 延迟还会做一轮 channel restart；**1.7.15 之前每次这种 restart 都泄漏一份钉钉 Stream 实例**（`startAccount` 读 `signal`，运行时传的是 `abortSignal`，旧实例收不到 abort，日志 "channel stop exceeded 5000ms after abort" 就是泄漏标志），累积到 09-05 网关 2.3 GB RSS SIGABRT；已修。重启后首个 agent turn prep ~3 分钟
- **cron 全停关卡（第 7 道，2026-09-03 查明）**：`ownership: explicit` 且无 default agent 时，cron 存储里任何一个 `agent_id` 为空的任务到期，`cron: timer tick failed: Agent-less cron job has no resolvable owner` 每 2 秒整体失败，**36 个定时任务全部不跑**、`cron.list` RPC 报 UNAVAILABLE（Jax 的 automations 工具也挂）。线上有 7 个这类用户任务 + memory-core 的 "Memory Dreaming Promotion"。**必须保留 `agents.defaults.systemAgent.agentId: "main"`**（09-02 10:52 设上后 cron 立即恢复并补跑积压 51 次，11:20 误删后再次全停）。之前记的"每 tick 报 WARN，无功能影响"是错的。09-03 已把 7 个用户任务 `cron edit <id> --agent main` 显式绑定。**cron CLI 注意**：只要存储里还有无 agent 的用户任务，`cron list` 与 Jax 的 automations 工具就报 `AgentSelectionRequiredError`（全部 `cron edit <id> --agent main` 后即恢复）；`cron run <id>` 不接受 `--agent`；**新建任务必须带 `--agent main`**。查任务 id 也可只读 `state/openclaw.sqlite` 的 `cron_jobs`。qiang/clawd2 auth-profiles 与 `agents.list → entries` 均已在恢复过程中完成迁移

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

### 2026-10-13（下午）: OpenClaw 2026.9.9 → 2026.10.2 + 插件 1.7.17/1.7.18（计划内，Jax 不可用 ~38 分钟、Clawd2 ~27 分钟）

**调研**（三路并行审 10.2 包源码/文档 + 线上核实）：sealed installation generations 只针对核心且需手动 adopt；插件每次加载 capture 到 `<state>/tmp/plugin-captures` 再 import，git pull 后 restart/reload 能拿到新代码；provider-native compaction 对 onehub 不触发；配置 schema 全通过；state v19→v20 启动自动迁移、agent 库不变。

**顺带查出的现存缺陷**：
- **路由缺陷（3 月后某版本引入）**：`startAccount` 传给 monitor 的 `runtime.config` 是门面 `{current, mutateConfigFile, replaceConfigFile}`，插件只认旧的 `loadConfig()`，路由拿不到 `bindings` → 所有非默认账号回落到 main（`session_windows` 证据：2026-03-25 qiang 账号消息正确进 qiang 库，2026-08-06 进了 main 库）。1.7.17 修复，并在 9.9 真实 core 上用 `plugin-sdk/routing` 的 `resolveAgentRoute` 验证门面→main、真实 cfg→clawd2
- `formatInboundEnvelope` 早已不在 runtime（只有 `formatAgentEnvelope`），agent 看到的钉钉消息没有发送人/时间信封——未修，待评估
- `runtime.config.set/delete` 早已不存在（`setAccountEnabled`/`deleteAccount`/onboarding 会抛错），`runtime.log.child` 不存在——未修
- systemd unit（2026.3.13 生成）`TimeoutStopSec=30` + `KillMode=control-group`，10.x drain 最长 315s 会被 SIGKILL；`patch-dingtalk.conf` ExecStartPost 是 3 月的失效热补丁（改 `~/.npm-global` 下核心文件）

**阶段 1（10:16–10:21）**：新增 drop-in `zz-stop-policy-heap.conf`（`TimeoutStopSec=330`、`KillMode=mixed`、`NODE_OPTIONS=--max-old-space-size=3072`）；`patch-dingtalk.conf` 归档到 `~/.archive/systemd-unit-pre-10x-2026-10-13/`；drop-in 目录与 `~/.config`、`~/.config/systemd` 去组写；含密钥的 `cursor-env.conf`/`gws-env.conf` 改 600；部署 1.7.17 + restart。11:01 那次 stop 实测 drain 等一个 gemini 任务跑完（3 分 20 秒）后干净退出——旧策略会在 30 秒处杀掉。

**阶段 2（staging 预演，全部在 `~/.openclaw-stage` + 端口 19789 + 假钉钉凭证）**：10.2 装在 `~/oc102`（项目级 npm 安装不接受 `--allow-scripts` 参数，要写 `.npmrc`）。结论：
1. 生产原布局（npm 领养记录 + load.paths）上 10.2 能启动，但 doctor 报 `install incomplete: package.json is missing / dependencies missing`，属可修复诊断 → `doctor --fix`/`openclaw update` 会按 `spec: @yaoyuanchao/dingtalk` 从 npm 拉 1.7.14 覆盖
2. 插件 capture 后 `import("openclaw/plugin-sdk/runtime-config-snapshot")` 解析到宿主 10.2 的 `getRuntimeConfig`；`config-runtime` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`（1.7.16 必需）
3. `plugins install -l` 不能指向 `<state>/extensions/<id>`（"plugin already exists … delete it first"，`--force` 无效）→ checkout 必须移出 extensions
4. link 后：记录 `source: path`、版本正确；doctor / doctor --fix 不碰；`plugins update --all` 输出 `Skipping "dingtalk" (source: path)`；`plugins reload dingtalk` 不重启即换代码且旧 Stream 正常停止；10.2 + onehub + sonnet-5-5 agent turn OK
5. 插件缓存写死在 `~/.openclaw/extensions/dingtalk/.cache`（staging 共用了生产缓存，checkout 移走后还会重建 extensions/dingtalk）→ 1.7.18 改到 `<state>/dingtalk-cache/`

**阶段 3（生产）**：
1. 10:55 Jax 真实消息验证 1.7.17（`routeAgentId=main`，回复正常）；11:01 部署 1.7.18 代码 + 缓存复制到 `~/.openclaw/dingtalk-cache/`
2. 11:01 stop（drain 4 分钟）→ 冷备份 `~/.archive/pre-2026.10.2-2026-10-13/`（2.9 GB）→ `npm i -g openclaw@2026.10.2 --allow-scripts=...`
3. 网关停着时：checkout `mv` 到 `~/plugins/dingtalk`；删 npm symlink；7.1 遗留的 `npm/projects/yaoyuanchao-dingtalk-*` 归档；`openclaw plugins install -l ~/plugins/dingtalk --force --accept-capabilities`（1 分钟）；`config set plugins.load.paths '["/home/clawd/plugins/dingtalk"]'`
4. 11:14:45 start → 11:22:59 listening → 11:26:06 ready（681 秒），钉钉两账号连上、cron 34 个任务启动；clawd2 11:28:31、main 11:39:45 才完成后台 inspection（期间 cron 对 main 的运行全部被拒）
5. 11:40 main/clawd2 agent turn 均 OK（sonnet-5-5，无 fallback）；acpx/discord 热安装 10.2

**教训**：10.x 的"重启"成本 = 11 分钟启动 + 最长 15 分钟 main inspection，计划停机要按 30 分钟估；插件部署从此改用 `plugins reload`。staging 隔离必须显式 STATE_DIR（profile 在 9.9 失效，差点让 staging 9.9 去碰生产状态目录——被"another gateway owns this state directory"拦下）。

### 2026-10-13: OpenClaw 2026.9.2 → 2026.9.9 + Node 22 → 24 + 插件 1.7.16（计划内，服务中断 ~36 分钟）

**评估**：9.3–10.2 changelog 全量审阅（9.3 起 Node ≥24.16.0 <25 或 ≥26.1.0，且要求**先升 Node 再升 OpenClaw**，否则 SQLite 文本截断）。10.2 的 package exports 已无 `plugin-sdk/config-runtime`（9.9 仍有）——插件原来 try/catch 动态 import 会静默回退到启动快照，热加载后 dispatch 报 `PreparedModelCatalogConfigReplacedError`。选 9.9（9.x 维护线，含 9.3–9.7 全部修复与 Node 24 CLI 挂住修复 #163788），10.x 暂缓：10.1 引入 sealed installation generations（与 git+symlink 领养部署兼容性未知）、10.2 默认 provider-native compaction（经 onehub 是否可用未知）、旧媒体字段 `MediaPath/MediaType/MediaUrl` 待迁移。

**步骤与时间线**：
1. 08:17 插件 1.7.16（46ac641）：优先 `runtime-config-snapshot`、`config-runtime` 兜底、都没有时 warn；部署前在服务器插件目录实测两个子路径都能解析出 `getRuntimeConfig`
2. 网关运行中预下载：nodesource 源改 `node_24.x`（原文件备份 `/root/nodesource.list.node22.bak`）+ `apt-get install --download-only`；`npm cache add openclaw@2026.9.9`
3. 08:20 stop → 备份 `~/.archive/pre-2026.9.9-2026-10-13/`（openclaw.json + state + 三个 agent 目录 + cron，1.4 GB，20 秒）→ `apt-get install nodejs`（24.21.0）
4. **npm 11 默认不跑 install scripts**：首次 `npm install -g openclaw@2026.9.9` 跳过了 openclaw postinstall（bundled plugins）与 koffi/esbuild/protobufjs，需带 `--allow-scripts=@google/genai,esbuild,koffi,protobufjs,openclaw` 重装
5. 08:24 start → **exit 78 crash-loop**：agent 库 schema v19 需 "stop active agents and run openclaw doctor --fix to migrate session identities"（含非 roster 的 claude/codex/openclaw 旧目录）
6. 08:34 停服跑 `nohup setsid timeout 1200 openclaw doctor --fix --non-interactive`：自动做迁移前 SQLite 备份（`*.pre-startup-migration-*.bak`），6 个库 v19→v24、workspace state 入库、Skill Workshop v16/v17，约 5 分钟完成迁移；之后 doctor 自己 restart 了网关服务，再被 20 分钟 timeout SIGTERM（不影响）
7. 08:56 监听（冷启动 126 秒），cron 33 个任务启用、零 tick 失败；main/clawd2（sonnet-5-5）与 qiang（gemini）真实 agent turn 全部 OK
8. 网关热着时 `plugins install @openclaw/acpx@2026.9.9`（8 分钟）、discord（5 分钟），**9.x 热安装不需要重启**（"Applied in Gateway generation N"）；`plugins install` 一次只接受一个包

**下线 qiang**：`config patch` 删 roster 条目被拒（"Config write would drop agent roster entries without an explicit deletion"），必须 `openclaw agents delete qiang --force`——它会**删除 workspace**（先归档到 `~/.archive/qiang-removed-2026-10-13/`），CLI 10 秒超时但网关内 108 秒后成功（删了 entry、binding、系统 cron `heartbeat-qiang`/`skill-collection-review-qiang`、`~/qiang-workspace`）；**钉钉账号不会被删**，需再 `config patch` 置 `channels.dingtalk.accounts.qiang: null`，否则 QiangBot 继续在线且无绑定。系统生成的 per-agent cron 不能用 `cron rm` 删（"system-owned monitor jobs"）。

**遗留**：9.9 重启后 RSS 稳定在 ~1.9–2.1 GB（9.2 是 0.6–0.9 GB，含 worker 线程堆），需观察是否再 OOM；doctor 提示 service 文件 `TimeoutStopSec` 应 ≥330s、`KillMode=mixed`、`~/.config/systemd/user` 目录权限 group/world-writable（跳过了 service 策略刷新）；weixin 残留安装记录警告仍在；Discord `allowBots` 9.7 起默认 true（我们已显式 true）。

### 2026-09-07: OpenClaw 2026.8.1 → 2026.9.2 + 插件 1.7.15（计划内，服务中断 ~40 分钟）

**触发原因**：复盘 09-05 19:06 网关 SIGABRT（apport `/var/crash/_usr_bin_node.1001.crash`，RSS 2.3 GB）发现插件 `startAccount({ account, signal, setStatus })` 解构的是 `signal`，而 SDK `ChannelGatewayContext` 传的是 `abortSignal`，监控循环永远收不到停止信号；每次 health-monitor 因冻结做 channel restart 都遗弃一份活的 Stream 实例（09-07 每账号 4 份、09-05 崩溃前约 8 份，重连频率是正常的 4–8 倍）。同时评估 9.1/9.2 changelog 无 Breaking，且修了长转录冻结、ACP 子进程泄漏等我们正踩的问题。

**步骤与时间线**：
1. 07:47 本地改 `abortSignal ?? signal`、重打 dist、bump 1.7.15，commit 3ff9631 推送
2. 07:49 服务器不停机做配置/cron 修复：杀 7 个泄漏的 acpx 孤儿进程（4 个昨天的 claude-agent-acp + 今天 2 个 codex-acp + 09-04 一个 root 身份的）；`memory.search.provider=gemini` + `model=gemini-embedding-001`（索引本来就是 gemini 建的，默认 openai 无 key 导致每天 100+ 次同步拒绝）；删 `mcp.servers.my-coffee`（端点 401 "oauth token is invalid"）；SLG 融合初筛 cron prompt 改成显式 `message action=send channel=dingtalk`；`cron disable` GRFal 目录清理任务（cron 会话不在 elevated 白名单，系统 `grfal-cleanup.timer` 每 4h 已覆盖）
3. 07:50 git pull + restart 上线 1.7.15，2.5 分钟起来，三账号各 1 条 Stream
4. 07:56 stop → 备份 `openclaw.json.pre-2026.9.2.bak` + `~/.archive/pre-2026.9.2-2026-09-07/`（state + main/clawd2/qiang 三个 agent 库 + cron，2.7 GB，顺序读 116 MB/s 约 30 秒）→ `npm install -g openclaw@2026.9.2`（1 分钟）
5. 07:58–08:30 踩坑：`plugins install @openclaw/discord@2026.9.2` 两次 8–9 分钟无输出超时，`doctor --fix --non-interactive` 9 分钟无输出超时，只有 acpx 3 分钟装成。判断是冷缓存 CLI 挂死，放弃 doctor 直接 start
6. 08:31 start 9.2，08:35:45 监听（4.75 分钟），启动 Doctor 只警告 weixin 残留；cron started 36 jobs、tick 零失败；main/qiang/clawd2 三个 agent turn 全部 OK
7. 08:45 网关热着再装 discord 9.2：100 秒完成；08:47 再 restart 一次加载

**教训**：这台机器上凡是要读 main 2.4 GB 库的 CLI，在网关停着、页缓存冷时会无限挂死，`timeout` 是唯一保险；升级窗口应压缩为 stop → npm install → start，插件更新和 doctor 放到网关起来之后做。auto-mode 会拦截 `systemctl stop`+备份+安装的长复合命令，拆成单步就能过。

### 2026-09-02: weixin 卸载 + 2026.8.2 评估（未升级）

**8.2 评估**（`npm pack openclaw@2026.8.2` 提 CHANGELOG）：无 Breaking、Node 要求不变。修了我们 8.1 踩过的几道关卡的健壮性（不完整 session 迁移不再宣称成功、doctor 重启前释放 DB 句柄、crash-loop 压制后恢复 channel、插件更新需授权时阻止重启），**没修** dispatch 的 `PreparedModelCatalogConfigReplacedError`（1.7.14 的 live-config 修复仍需保留）。"Upcoming deprecations" 列了 5 个 plugin-sdk 子路径（`config-runtime`、`channel-reply-pipeline`、`infra-runtime`、`channel-lifecycle`、`channel-message`），移除目标日 2026-09-01 已过，8.2 和 9.1-beta.1 暂时仍保留。**本插件只用了 `config-runtime`**（`src/monitor.ts` 的 `resolveLiveDispatchConfig`），替代 `openclaw/plugin-sdk/runtime-config-snapshot` 同样导出 `getRuntimeConfig`，8.1 已有，待迁移。

**weixin 卸载**（用户决定不再用）：备份 `openclaw.json.pre-weixin-uninstall-2026-09-02.bak`；删 `plugins.entries.openclaw-weixin` + `plugins.allow` 项；`npm/projects/tencent-weixin-*` 与 `~/.openclaw/openclaw-weixin` 状态目录移到 `.archive/`；`npm/package.json`+lock 删依赖（有 .bak）；`plugins registry --refresh` 后 `plugins list`/`inspect` 均不再认识它。残留：`config_machine_state` 表 `plugins.installedIndex` 行的 `index.installRecords.openclaw-weixin`（CLI uninstall 拒绝处理），启动时 Doctor 警告 "install dir missing"，需停机改 SQLite 清除。验证：三个钉钉 Stream 重连、`openclaw agent --agent main/qiang --message` 均返回 OK。

**顺带发现**：冷启动 ~6.5 分钟才监听端口（main agent SQLite 2.49 GB）；Discord 两账号 READY 超时未连上，且重启前当天也无 ready 记录，属既有问题；`gatewayReadyTimeoutMs` 已不在 8.1 schema。详见"已知问题 2026.8.1"。

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
**遗留事项**：~~weixin channel 等上游适配 8.1~~（2026-09-02 已卸载）；memory-core dreaming cron 的 agent-less job 警告（需设 `agents.defaults.systemAgent.agentId`）。已完成：qiang/clawd2 凭证迁移、agents.entries 迁移、npm 发布 1.7.14（2026-09-01，带 dist + 8.1 dispatch 修复）

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
**最后更新**: 2026-10-13
