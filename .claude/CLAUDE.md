# DingTalk Clawdbot Plugin

> DingTalk Channel Plugin for ClawdBot/OpenClaw（@yaoyuanchao/dingtalk@1.5.4）

## 状态

- ✅ OpenClaw 2026.2.23 升级（2026-02-25）— 详见下方升级记录
- ✅ v1.5.5 — 修复 Stream auto-restart 循环（startDingTalkMonitor 提前返回问题）
- ✅ v1.5.4 — 新增 markdown 消息类型支持
- 🔄 待办: 单元测试、CI/CD

## 快速参考

| 信息 | 值 |
|------|-----|
| NPM 包 | `@yaoyuanchao/dingtalk` v1.5.4 |
| GitHub | https://github.com/akedia/dingtalk-clawdbot |
| 远端服务器 | `ssh root@172.20.90.45`，运行用户 `clawd`（clawd1）/ `clawd2`（clawd2） |
| Gateway 管理 | `openclaw gateway restart/stop/start/status` |
| 插件升级 | `openclaw plugins update dingtalk` |
| clawd1 模型 | `google/gemini-3.1-pro-preview` via Google AI（不需要代理） |
| clawd2 模型 | `amazon-bedrock/us.anthropic.claude-sonnet-4-6` via AWS Bedrock（需 Clash 代理） |
| Bedrock 可用模型 | Sonnet 4.6: `us.anthropic.claude-sonnet-4-6`，Opus 4.6: `us.anthropic.claude-opus-4-6-v1`，Sonnet 4.5: `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| 备用 Provider | `custom-anthropic`，baseUrl `api.modelverse.cn`（不需要代理） |
| 代理服务 | mihomo (Clash Meta) v1.19.0，`systemctl status mihomo`（clawd2 Bedrock 需要，clawd1 不需要） |
| OpenClaw 版本 | `2026.2.23`（`2026.2.24` 可升级，含 Discord block-streaming 修复） |
| 本地分支 | `master` |

## 详细文档（按需阅读）

需要深入了解时，读取对应子文档：

- **[docs/server.md](docs/server.md)** — 远端服务器连接、环境、运行状态、常用操作、日志解读
- **[docs/clawdbot-platform.md](docs/clawdbot-platform.md)** — Clawdbot/Moltbot/OpenClaw 平台知识、插件开发 API、CLI 命令、配置结构
- **[docs/development.md](docs/development.md)** — 本地开发环境、目录结构、核心代码、技术栈、设计决策、NPM 发布
- **[docs/operations.md](docs/operations.md)** — **NPM 发布流程**、已知问题、故障排查、用户升级方案

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

### 模型配置（双实例）

**clawd1**（端口 18789，systemd 服务）:
- 模型: `google/gemini-3.1-pro-preview` via Google AI
- 代理: **无**（Gemini 走 IT 透明代理可直连）
- systemd 服务文件: `/home/clawd/.config/systemd/user/openclaw-gateway.service`

**clawd2**（端口 18790，nohup 手动进程）:
- 模型: `amazon-bedrock/us.anthropic.claude-sonnet-4-6` via AWS Bedrock
- 代理: `HTTPS_PROXY=http://127.0.0.1:7890`（启动命令中注入，需 mihomo 运行）
- 启动命令: `cd /home/clawd2 && sudo -u clawd2 bash -c 'HOME=/home/clawd2 PATH=/usr/local/bin:/usr/bin:/bin HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 NO_PROXY=localhost,127.0.0.1,172.20.0.0/16,10.0.0.0/8 nohup openclaw gateway --port 18790 > /tmp/clawd2-gateway.log 2>&1 &'`

**切换模型注意事项**:
- Gemini 不需要代理，Gateway 进程**不要**配 `HTTPS_PROXY`
- Bedrock 需要代理，Gateway 进程**必须**配 `HTTPS_PROXY=http://127.0.0.1:7890` 并启动 mihomo
- **代理和模型必须同时切换**：只停 mihomo 不去 `HTTPS_PROXY` 会导致所有请求 `fetch failed`；只去 `HTTPS_PROXY` 不停 mihomo 则浪费资源
- clawd1 的代理通过 systemd 服务 `Environment=` 管理；clawd2 通过启动命令环境变量注入

**Bedrock 可用 Claude 模型**:
- Sonnet 4.6: `us.anthropic.claude-sonnet-4-6`
- Opus 4.6: `us.anthropic.claude-opus-4-6-v1`
- Sonnet 4.5: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
- Opus 4.5: `us.anthropic.claude-opus-4-5-20251101-v1:0`
- Haiku 4.5: `us.anthropic.claude-haiku-4-5-20251001-v1:0`

Gemini 已知问题：
- `thinking=high` 模式下，长 session 多轮对话后偶尔首次调用报错，重试后可能返回工具调用而非文字，导致无输出
- Preview 模型稳定性不如正式版，偶发超时
- 指令遵循不如 Claude — 可能泄露 subagent 内部信息、发送重复消息、图片错乱

### 网络代理架构（仅 Bedrock 需要）

远端服务器 IP 在中国，AWS Bedrock 和 Anthropic API 拒绝直连。通过 Clash 代理解决：

- **mihomo (Clash Meta)** 运行在远端 `172.20.90.45`，端口 `127.0.0.1:7890`
- 配置文件: `/etc/clash/config.yaml`（kycloud 订阅）
- systemd 服务: `mihomo.service`（root 级，enabled 但当前可能 inactive）
- 模式: **rule**（国内直连，国外走代理）
- 代理节点: `S-IEPL-美国4`，通过 `🚀 节点选择` 组管理

**流量路由**（Clash rule 层面）:
- `amazonaws.com`（含 Bedrock）→ 走代理节点
- `discord.com` / `discordapp.com` 等 → **DIRECT 直连**（该网络可直连 Discord）
- `dingtalk.com` 等国内域名 → 直连

**IT 网络代理（透明代理）**:
- IT 已在网络层配置了 `amazonaws.com`、`openrouter.ai`、`api.anthropic.com` 的代理
- 对 `curl` 有效（出口 IP `154.3.34.89`），但**对 AWS SDK 无效**（SDK 需要 `HTTPS_PROXY` 环境变量）
- Gemini API (`generativelanguage.googleapis.com`) 通过 IT 透明代理可直连

### AWS Bedrock 配置

- Provider: `amazon-bedrock`，API: `bedrock-converse-stream`
- 当前使用: `us.anthropic.claude-sonnet-4-6`（clawd2）
- 认证: AWS Access Key 配置在 `openclaw.json` 的 `env` 中
- Region: `us-east-1`
- Bedrock 模型 ID 注意事项:
  - 基础模型 ID（如 `anthropic.claude-sonnet-4-6`）不能直接调用 on-demand
  - 必须使用 inference profile ID（如 `us.anthropic.claude-sonnet-4-6`）
  - Sonnet 4.6 的 inference profile ID 没有版本后缀（不像 4.5 带 `:0`）

## Debugging Protocol

1. 诊断 API 错误：先获取并展示完整错误响应，再提修复方案
2. 不根据文档猜测 HTTP 错误原因——要验证实际请求/响应
3. 日志监控/异步任务：每 2-3 次检查汇总一次状态，不反复 dump 原始日志
4. 关联日志事件时始终验证 request ID——不假设最近事件属于当前跟踪任务
5. 使用 [docs/server.md](docs/server.md) 中的 Python 格式化命令提取可读日志，不要 raw `tail`

## Change Management Rules

- 新功能默认创建为 STANDALONE 组件（独立 URL），除非明确要求集成到现有页面
- 架构变更（服务配置等）前先陈述对系统架构的理解，等用户确认后再动手
- 修复不成功后先 REVERT 再尝试其他方案，不要叠加修复
- 修改 `src/monitor.ts`（最大文件 600+ 行）时做定向修改，不要顺带重构周围代码

## 远端部署速查（Git 方式）

```bash
# 本地：推送到 GitHub
git push origin master

# clawd1 远端：拉取 + 重启（systemd 服务）
ssh root@172.20.90.45 "sudo -u clawd bash -c '
  cd /home/clawd/.openclaw/extensions/dingtalk && git pull
' && sudo -u clawd \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  openclaw gateway restart"

# clawd2 远端：拉取 + 重启（手动进程，需带代理环境变量）
ssh root@172.20.90.45 "sudo -u clawd2 bash -c '
  cd /home/clawd2/.openclaw/extensions/dingtalk && git pull
' && pkill -9 -u clawd2 -f openclaw && sleep 2 \
  && rm -f /tmp/clawd2-gateway.log && touch /tmp/clawd2-gateway.log && chown clawd2:clawd2 /tmp/clawd2-gateway.log \
  && cd /home/clawd2 && sudo -u clawd2 bash -c '
  HOME=/home/clawd2 PATH=/usr/local/bin:/usr/bin:/bin \
  HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 \
  NO_PROXY=localhost,127.0.0.1,172.20.0.0/16,10.0.0.0/8 \
  nohup openclaw gateway --port 18790 > /tmp/clawd2-gateway.log 2>&1 &'"
```

**注意**:
- 远端使用 **Git 部署**（非 npm），远程 agent 可自行修改代码并提交
- `su - clawd` 不建立 systemd 用户会话，必须注入环境变量
- **不要用** `openclaw plugins update dingtalk`（会覆盖为 npm 版本）
- clawd2 没有 systemd 服务，用 nohup 手动启动，**必须注入代理环境变量**
- clawd2 的 `/tmp/clawd2-gateway.log` 需要先修复权限（可能被 root 创建）
- 详见 [docs/operations.md](docs/operations.md) 的 Git 部署章节

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

### OpenClaw 2026.2.23（当前版本）
- ~~`channels.discord.streaming` 被 Zod 拒绝（#23031）~~ — **已修复**，统一为 `channels.<channel>.streaming` 枚举 `off|partial|block|progress`
- ~~`operator.write/read` scope 需手动 patch（#23006）~~ — **已修复**，admin token 自动满足 write scope
- ~~session compaction retry 卡死 gateway~~ — **大幅改善**，compaction 失败时优雅取消而非无限重试
- **Discord block-streaming 丢消息 bug**：`blockStreamingDefault: "on"` 会导致 Discord 回复静默丢失（reasoning payload 和正常 payload 一起被抑制）。**2026.2.24 修复**。当前解决方案：已移除 `blockStreamingDefault`，改用 `channels.discord.streaming: "partial"`
- Gateway 高负载时 "Slow listener detected" — 未修复，但 WS flood 防护有改善
- **新安全要求**：LAN 绑定的 gateway 需要 `gateway.controlUi.allowedOrigins` 或 `dangerouslyAllowHostHeaderOriginFallback: true`
- `openclaw doctor --fix` 可能向 channel 配置注入平台级键（如 `allowFrom`）— 插件的 Zod schema 需用 `.passthrough()` 而非 `.strict()` 以兼容

### clawd2 特有
- 没有 systemd 服务，进程管理脆弱（nohup）
- ~~session 过大时 compaction retry 会卡住整个 gateway~~ — 2026.2.23 已改善
- `sessions.json` 中如果有执行过 `killall` 的 session，恢复时会自杀 — 清 session 前要检查

## 升级记录

### 2026-02-25: OpenClaw 2026.2.21-2 → 2026.2.23

**变更清单**：

| 配置项 | 旧值 | 新值 | 原因 |
|--------|------|------|------|
| OpenClaw 版本 | `2026.2.21-2` | `2026.2.23` | 修复多个已知问题 |
| `channels.discord.streaming` | `off`（被 Zod 拒绝） | `partial` | 流式输出支持 |
| `agents.defaults.blockStreamingDefault` | `"on"` | **已移除** | 旧 workaround，在 2023 中导致 Discord 回复丢失 |
| `agents.defaults.blockStreamingBreak` | `"text_end"` | **已移除** | 配套移除 |
| `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback` | 不存在 | `true` | 2023 新安全要求，LAN 绑定必须设置 |
| systemd `ExecStart` | `dist/entry.js` | `dist/index.js` | 2023 entrypoint 变更 |
| 插件 `config-schema.ts` | `.strict()` | `.passthrough()` | 兼容平台注入键（`allowFrom` 等） |

**升级中遇到的问题及解决**：

1. **Gateway 启动失败** — `controlUi.allowedOrigins` 新安全要求，添加 `dangerouslyAllowHostHeaderOriginFallback: true` 解决
2. **clawd2 DingTalk channel 启动失败** — `openclaw doctor --fix` 注入 `channels.dingtalk.allowFrom`，被插件 `.strict()` schema 拒绝。改为 `.passthrough()` 解决
3. **Discord 回复静默丢失** — `blockStreamingDefault: "on"` 在 2023 中有 bug，会抑制所有 payload（不只是 reasoning）。移除该 workaround 后恢复正常
4. **systemd entrypoint 不匹配** — 2023 将入口从 `entry.js` 改为 `index.js`，需更新 systemd 服务文件

**升级收益**：
- `operator.write/read` 不再需要手动 patch `paired.json`
- Discord streaming 正常工作（`partial` 模式流式输出）
- Session compaction 不再卡死 gateway
- `fetch failed` 归类为 transient，不再导致 gateway crash loop（对 clawd2 代理网络重要）
- 支持 `openclaw sessions cleanup` 清理磁盘
- Hot reload 支持（config 修改自动生效，无需重启）

### 后续升级注意事项

1. **升级到 2026.2.24 时**：Discord block-streaming bug 修复，届时可考虑恢复 `blockStreamingDefault` 如果需要
2. **`openclaw doctor --fix` 后务必检查**：它可能向 channel 配置注入插件不认识的键。目前 `.passthrough()` 可兼容，但要注意 doctor 修改了什么
3. **Breaking changes 检查**：每次升级前用 `npm pack openclaw@<version>` 提取 CHANGELOG.md 查看 Breaking 部分
4. **升级步骤**：`npm install -g openclaw@<version>` → `openclaw doctor --fix`（检查输出）→ 更新 systemd 服务文件（如需要）→ 重启 gateway → 验证所有 channel 连接
5. **回滚方案**：`openclaw.json.bak` 是 doctor 自动创建的备份，可用于回滚配置

---
**最后更新**: 2026-02-25
