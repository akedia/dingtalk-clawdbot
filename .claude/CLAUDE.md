# DingTalk Clawdbot Plugin

> DingTalk Channel Plugin for ClawdBot/OpenClaw（`@yaoyuanchao/dingtalk` v1.7.11）

## 状态

- ✅ OpenClaw 2026.4.22 升级（2026-04-24）— 修复 reply dispatcher 流式末尾重复发送问题，详见升级记录
- 🔄 待办: 单元测试、CI/CD

## 快速参考

| 信息 | 值 |
|------|-----|
| NPM 包 | `@yaoyuanchao/dingtalk` v1.7.11 |
| GitHub | https://github.com/akedia/dingtalk-clawdbot |
| 远端服务器 | `ssh root@172.20.90.45`，运行用户 `clawd` |
| Gateway 管理 | `openclaw gateway restart/stop/start/status` |
| 插件升级 | **不要用** `openclaw plugins update dingtalk`（会覆盖为 npm 版本），用 git pull |
| 模型 | `onehub-claude/claude-sonnet-4-6`（via onehub，不需要代理） |
| OpenClaw 版本 | `2026.4.22` |
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
- **模型 provider**：`onehub-claude`，走 onehub 网关，不需要代理

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

### OpenClaw 2026.4.22（当前版本）
- `openclaw doctor --fix` 可能向 channel 配置注入平台级键（如 `allowFrom`）— 插件的 Zod schema 用 `.passthrough()` 兼容
- LAN 绑定的 gateway 需要 `gateway.controlUi.allowedOrigins` 或 `dangerouslyAllowHostHeaderOriginFallback: true`（2026.2.23 起要求）

## 升级记录

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
**最后更新**: 2026-04-24
