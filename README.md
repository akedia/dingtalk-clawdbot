# 🤖 DingTalk Plugin for OpenClaw

[![npm](https://img.shields.io/npm/v/@yaoyuanchao/dingtalk.svg)](https://www.npmjs.com/package/@yaoyuanchao/dingtalk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

让你的 AI 助手住进钉钉。**无需公网域名，3 分钟搞定。**

## ✨ 特性

- 🚀 **Stream 模式** — 无需公网域名，内网即可用
- 💬 **私聊 + 群聊** — 完整的消息收发支持
- 🖼️ **富媒体** — 图片、语音、视频、文件接收
- ⏳ **思考中提示** — 自动显示处理状态，完成后消失
- 🔒 **访问控制** — 灵活的用户/群组白名单

## 🚀 快速开始

```bash
# 1. 安装
openclaw plugins install @yaoyuanchao/dingtalk

# 2. 配置（交互式向导）
openclaw onboard --channel dingtalk

# 3. 启动
openclaw gateway
```

> ClawdBot（旧名）用户见 [UPGRADE.md](./UPGRADE.md) 的迁移指南。

完事！去钉钉找机器人聊天吧。

## ⚙️ 配置示例

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingXXXXXXXXXXXX",
      "clientSecret": "YOUR_SECRET",
      "dm": {
        "policy": "pairing",
        "allowFrom": ["YOUR_STAFF_ID"]
      }
    }
  }
}
```

<details>
<summary>📋 完整配置项</summary>

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `clientId` | 钉钉应用 AppKey | - |
| `clientSecret` | 钉钉应用 AppSecret | - |
| `dm.policy` | 私聊策略: `pairing`/`open`/`disabled` | `pairing` |
| `dm.allowFrom` | 允许私聊的 staffId 列表 | `[]` |
| `groupPolicy` | 群聊策略: `allowlist`/`open`/`disabled` | `allowlist` |
| `groupAllowlist` | 允许的群 conversationId 列表 | `[]` |
| `requireMention` | 群聊是否需要 @机器人 | `true` |
| `messageFormat` | 消息格式: `text`/`markdown`/`auto` | `auto` |
| `typingIndicator` | 显示"思考中"提示 | `true` |
| `longTextMode` | 长文本处理: `chunk`/`file` | `chunk` |
| `groups.<id>.systemPrompt` | 指定群的额外 system prompt | - |
| `groups.<id>.enabled` | 是否启用该群（false = 完全忽略） | `true` |
| `groups.<id>.allowFrom` | 该群只响应这些 staffId 的消息（支持 `"*"` 通配符） | `[]`（不限制） |

</details>

## 🔑 获取凭证

1. 打开 [钉钉开发者平台](https://open-dev.dingtalk.com)
2. 创建企业内部应用 → 添加机器人能力
3. 消息接收模式选 **Stream 模式**
4. 复制 AppKey (clientId) 和 AppSecret (clientSecret)
5. 发布应用

## 💡 获取 staffId

首次私聊机器人时会返回：
```
Access denied. Your staffId: 050914XXXXXXXXX
```
把这个 ID 加到 `dm.allowFrom` 里，重启 gateway 即可。

## 🔒 群聊发言人限制（Per-group allowFrom）

可以让机器人在某个群里**只响应指定用户**的 @ 消息，其他人 @ 会被静默忽略。

```json
{
  "channels": {
    "dingtalk": {
      "groups": {
        "<conversationId>": {
          "allowFrom": ["050914185922786044"]
        }
      }
    }
  }
}
```

**获取 conversationId：** 机器人收到群消息时日志里会打印，或通过钉钉开放平台 API 查询。

**支持通配符：** `"allowFrom": ["*"]` 表示允许所有人（等同于不设置）。

**与 `dm.allowFrom` 的区别：**
- `dm.allowFrom` — 私聊白名单（全局）
- `groups.<id>.allowFrom` — 指定群的发言人白名单（per-group）

## 🐏 herdr 远程控制（/hd）

在钉钉私聊里遥控 [herdr](https://herdr.dev) 管着的多台机器上的 coding agent，并在 agent 卡住、出错、完成时收到推送。`/hd` 消息由插件直接处理，不经过 AI。

```json
{
  "channels": {
    "dingtalk": {
      "herdr": {
        "token": "<herdr-bridge 的 token>",
        "account": "default",
        "allowFrom": ["050914XXXXXXXXX"]
      }
    }
  }
}
```

| 命令 | 作用 |
|---|---|
| `/hd ls` | 列出所有机器的终端与 agent 状态 |
| `/hd read <t> [行数]` | 读屏 |
| `/hd reply <t>` | 先看屏，下一条消息转给它（5 分钟内） |
| `/hd send <t> <内容>` | 直接发给 agent |
| `/hd ok <t> [选项] [#编号]` / `/hd trust <t> [#编号]` / `/hd no <t> [#编号]` | 批准一次 / 始终允许 / 拒绝；带 `#编号` 时只在 agent 仍卡在这个提问上才按键 |
| `/hd int <t>` / `/hd kill <t>` | 中断当前回合 / 结束终端 |
| `/hd new <机器> <项目> [模板] <任务>` | 用模板在已登记项目里起新 agent |
| `/hd digest` | 今日工作时长、卡住次数、完成轮数 |
| `/hd task …` | 任务（Agent Hub），见下 |

### 任务：`/hd task`（Agent Hub）

任务在目标机器的 [Agent Hub](https://github.com/akedia/x3analyze/tree/main/qa/agent-hub) 里执行：每个任务有自己的 worktree，由该项目登记的独立验收脚本判定是否完成；评审意见回到原任务、原 worktree 续跑。中继服务每 30 秒推进一次各机器的任务，读取 Hub 的通知并推送（已交报告、验收通过/未通过、worker 卡住、需要决定、执行器没就绪）。验收通过不等于已合入，合入和部署仍需人工确认。

| 命令 | 作用 |
|---|---|
| `/hd task` | 帮助 + 各机器已登记的项目 |
| `/hd task ls [机器]` | 任务列表 |
| `/hd task new <机器> <项目> <目标…>` | 提交并立即开始（目标可以多行） |
| `/hd task show <机器>/<id>` | 详情：状态、最近验收、尝试、待决定（id 写前 4 位以上） |
| `/hd task fu <机器>/<id> <意见…>` | 评审意见，同一任务续跑 |
| `/hd task pause\|resume\|cancel <机器>/<id>` | 暂停 / 恢复 / 取消 |
| `/hd task decide <机器>/<决定id> <选项>` | 回答 Hub 提出的决定 |

项目由机器上的操作者用 `hub.py register` 登记（仓库、基线分支、worker 模板、验收脚本），钉钉侧只能选已登记的项目。

回复和推送附带可复制发送的 `/hd` 操作指令。1.9.0 使用的 `dtmd://` 链接已在钉钉 Windows 客户端出现“此链接无法识别”，1.9.1 停止输出这些链接。**当前没有原生可点击操作按钮**；它需要单独接入互动卡片模板和 Stream 卡片回调，并完成客户端实测。只在私聊、只对 `allowFrom`（默认 `dm.allowFrom`）、只在 `herdr.account` 指定的账号生效。需要在 gateway 主机上部署 `bridge/herdr-bridge.mjs`，见 [bridge/README.md](./bridge/README.md)。

## 📝 更新日志

**v1.11.0** — `/hd task`：从钉钉提交和管理 Agent Hub 任务，进度与验收结果推送

**v1.10.x** — 批准/拒绝带提问编号，过期的选择不再按到新问题或工作中的 agent；不带编号时也不打断工作中的 agent；已结束的终端明确提示「已结束」

**v1.9.x** — `/hd reply` / `/hd trust`；1.9.1 用可复制操作指令替代不兼容的链接

**v1.8.x** — herdr 远程控制：`/hd` 命令与 agent 状态推送

**v1.7.x** — Queue lane 路由（`/btw` 与 `/stop` 独立通道）、Cron/proactive 消息走 deliverReply 保持 persona

**v1.5.x** — 新增 Typing Indicator（思考中提示，自动撤回）、OpenClaw 兼容

**v1.4.x** — 媒体消息支持、长文本文件发送

查看完整 [CHANGELOG](./CHANGELOG.md)

## 📄 License

MIT
