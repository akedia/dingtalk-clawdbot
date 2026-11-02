/**
 * herdr remote control over DingTalk DMs.
 *
 * `/hd ...` commands from allow-listed staffIds (DM only, one configured account)
 * are answered directly — they never reach the AI agent. Agent status changes
 * (blocked / error / turn finished / exited) are pushed to the same people.
 *
 * Replies are markdown with `dtmd://dingtalkclient/sendMessage` links: tapping one makes
 * the client send that `/hd` command as the user, so buttons need no card template or
 * callback and go through the same allow-list as typed commands.
 *
 * Talks to herdr-bridge (bridge/herdr-bridge.mjs) on the gateway host, which
 * owns the `hc` client and the SSH keys; this process only holds its token.
 */
import * as fs from "fs";
import * as path from "path";
import type { ResolvedDingTalkAccount } from "./types.js";
import { sendDMMessageWithKey } from "./api.js";
import { resolveDingTalkCacheFile } from "./cache-dir.js";

export interface HerdrConfig {
  enabled?: boolean;
  account?: string;        // which DingTalk account answers /hd and pushes (default "default")
  bridgeUrl?: string;      // default http://127.0.0.1:8377
  token?: string;
  allowFrom?: string[];    // staffIds; default: dm.allowFrom of that account
  notify?: boolean;        // push status changes (default true)
  pollSeconds?: number;    // default 5
}

export type HerdrReply = (text: string, opts?: { markdown?: boolean; title?: string }) => Promise<unknown>;

const CMD_RE = /^\/hd(\s|$)/i;
const SCREEN_MAX = 3000;
const REPLY_WINDOW_MS = 5 * 60_000;

export function isHerdrCommand(text: string): boolean {
  return CMD_RE.test(text.trim());
}

/** Commands with effects; these go through content dedup so a redelivery can't run them twice. */
export function isHerdrWriteCommand(text: string): boolean {
  const sub = (text.trim().split(/\s+/)[1] || "").toLowerCase();
  if (sub === "reply" || sub === "r") return text.trim().split(/\s+/).length > 3; // reply with text = send
  return ["send", "s", "ok", "yes", "approve", "trust", "always", "no", "esc", "int", "interrupt", "stop", "kill", "new"].includes(sub);
}

function herdrConfig(account: ResolvedDingTalkAccount): HerdrConfig | null {
  const h = (account.config as any)?.herdr as HerdrConfig | undefined;
  if (!h || h.enabled === false || !h.token) return null;
  if ((h.account ?? "default") !== account.accountId) return null;
  return h;
}

function allowList(account: ResolvedDingTalkAccount, h: HerdrConfig): string[] {
  const list = h.allowFrom?.length ? h.allowFrom : ((account.config as any)?.dm?.allowFrom ?? []);
  return list.map(String).filter((s: string) => s && s !== "*");
}

async function bridge(h: HerdrConfig, p: string, body?: unknown, timeoutMs = 150_000): Promise<any> {
  const url = (h.bridgeUrl || "http://127.0.0.1:8377").replace(/\/$/, "") + p;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const data: any = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok && data.ok !== false) data.ok = false;
    return data;
  } catch (err) {
    return { ok: false, error: `bridge unreachable: ${String((err as Error)?.message || err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- formatting ----------

const STATE_ICON: Record<string, string> = { working: "🟢", blocked: "🔴", error: "❌", done: "✅", idle: "⚪" };
const STATE_TEXT: Record<string, string> = { working: "工作中", blocked: "等你处理", error: "出错", done: "完成", idle: "空闲" };
const KIND_TEXT: Record<string, string> = {
  blocked: "🔴 需要你处理", error: "❌ 出错", done: "✅ 完成", turn_end: "✅ 本轮完成", exited: "⏹ 已退出",
};

/** A markdown link that, when tapped, sends `cmd` as the user. */
export function cmdLink(label: string, cmd: string): string {
  return `[${label}](dtmd://dingtalkclient/sendMessage?content=${encodeURIComponent(cmd)})`;
}

function cleanScreen(text: string, maxLines: number): string {
  const lines = String(text || "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n").map((l) => l.replace(/\s+$/, "").replace(/^\s{8,}/, "  ").replace(/\s{8,}/g, "  "))
    .filter((l, i, a) => l || (a[i - 1] ?? "") !== "");
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  let out = lines.slice(-maxLines).join("\n");
  if (out.length > SCREEN_MAX) out = "…" + out.slice(-SCREEN_MAX);
  return out;
}

/** Screen lines as a markdown quote, with characters that would turn into formatting neutralized. */
function mdScreen(screen: string): string {
  const safe = (l: string) => l
    .replace(/[[\]]/g, (c) => (c === "[" ? "［" : "］"))
    .replace(/[*_`#|~<>]/g, (c) => ({ "*": "∗", "_": "＿", "`": "ˋ", "#": "＃", "|": "｜", "~": "～", "<": "‹", ">": "›" } as any)[c]);
  const lines = screen.split("\n").filter((l) => l.trim());
  return lines.length ? lines.map((l) => `> ${safe(l)}`).join("  \n") : "> （空屏）";
}

function actionsFor(t: string, state: string | null): string {
  const a = [cmdLink("读屏", `/hd read ${t}`), cmdLink("回复", `/hd reply ${t}`)];
  if (state === "blocked") a.unshift(cmdLink("批准", `/hd ok ${t}`), cmdLink("始终允许", `/hd trust ${t}`), cmdLink("拒绝", `/hd no ${t}`));
  if (state === "working") a.push(cmdLink("中断", `/hd int ${t}`));
  return a.join(" · ");
}

function mdLs(d: any): string {
  if (!d.ok) return `❌ ${d.error || d.out || "ls failed"}`;
  const machines = (d.machines || []).map((m: any) => `${m.name} ${m.state === "connected" ? "在线" : m.state}`).join(" · ");
  const terms: any[] = d.terminals || [];
  const agents = terms.filter((t) => t.status || t.app);
  const shells = terms.filter((t) => !t.status && !t.app);
  const order: Record<string, number> = { blocked: 0, error: 1, working: 2, done: 3, idle: 4 };
  agents.sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5));
  const out: string[] = [`#### herdr · ${machines || "仅本机"}`];
  if (agents.length) {
    for (const t of agents) {
      const icon = STATE_ICON[t.status] || "•";
      const msg = t.msg ? ` · ${String(t.msg).slice(0, 60)}` : "";
      out.push(`**${icon} ${t.t}**${t.name ? ` (${t.name})` : ""} ${t.app || t.agent || ""} · ${t.where || t.cwd || ""} · ${STATE_TEXT[t.status] || t.status || ""}${msg}  \n${actionsFor(t.t, t.status)}`);
    }
  } else {
    out.push("没有在跑的 agent");
  }
  if (shells.length) {
    out.push("终端：" + shells.map((t) => cmdLink(`${t.t} ${t.where || ""}`.trim(), `/hd read ${t.t}`)).join(" · "));
  }
  out.push([cmdLink("刷新", "/hd ls"), cmdLink("今日", "/hd digest"), cmdLink("帮助", "/hd")].join(" · "));
  return out.join("\n\n");
}

const HELP_MD = [
  "#### herdr 遥控（只认私聊）",
  "- `/hd ls` 列出所有终端和 agent，带按钮",
  "- `/hd read <t> [行数]` 读屏",
  "- `/hd reply <t>` 先看屏，你的下一条消息转给它（5 分钟内）",
  "- `/hd send <t> <内容>` 直接发给 agent",
  "- `/hd ok <t> [选项]` 批准；`/hd trust <t>` 始终允许；`/hd no <t>` 拒绝",
  "- `/hd int <t>` 中断；`/hd kill <t>` 结束",
  "- `/hd new <机器> <项目> [模板] <任务>` 起新 agent",
  "- `/hd digest` 今日活动；`/hd cancel` 取消待回复",
  "",
  "机器 dev（默认 Codex）· v172（默认 Claude）；项目 x3analyze / grfal / skills；模板 worker / advisor / verifier，加 -codex 用 Codex",
  "",
  [cmdLink("列表", "/hd ls"), cmdLink("今日", "/hd digest")].join(" · "),
].join("\n");

// ---------- pending "reply" (next message goes to an agent) ----------

const pendingReply = new Map<string, { t: string; until: number }>();
const pendingKey = (accountId: string, senderId: string) => `${accountId}:${senderId}`;

/**
 * After `/hd reply <t>`, the sender's next DM (not a /hd command) goes to that agent.
 * Returns true when it consumed the message.
 */
export async function handleHerdrPendingReply(params: {
  account: ResolvedDingTalkAccount; senderId: string; isDm: boolean; text: string; reply: HerdrReply; log?: any;
}): Promise<boolean> {
  const { account, senderId, isDm, text, reply, log } = params;
  if (!isDm || isHerdrCommand(text)) return false;
  const key = pendingKey(account.accountId, String(senderId));
  const p = pendingReply.get(key);
  if (!p) return false;
  pendingReply.delete(key);
  if (Date.now() > p.until) return false;
  const h = herdrConfig(account);
  if (!h || !allowList(account, h).includes(String(senderId))) return false;
  const body = text.trim();
  if (!body) return false;
  const d = await bridge(h, "/send", { t: p.t, text: body });
  await reply(d.ok
    ? `📨 已发给 ${p.t}\n\n${[cmdLink("读屏", `/hd read ${p.t}`), cmdLink("再回复", `/hd reply ${p.t}`), cmdLink("列表", "/hd ls")].join(" · ")}`
    : `❌ 发给 ${p.t} 失败：${JSON.stringify(d.out || d.error).slice(0, 300)}`, { markdown: true, title: `已发给 ${p.t}` });
  log?.info?.(`[dingtalk][herdr] reply → ${p.t} (${body.length} chars)`);
  return true;
}

// ---------- commands ----------

export async function handleHerdrCommand(params: {
  account: ResolvedDingTalkAccount;
  senderId: string;
  isDm: boolean;
  text: string;
  reply: HerdrReply;
  log?: any;
}): Promise<boolean> {
  const { account, senderId, isDm, text, reply, log } = params;
  if (!isHerdrCommand(text)) return false;
  const h = herdrConfig(account);
  if (!h) return false; // not this account's feature: let the message go on as usual
  if (!isDm) return true; // never in groups: swallow silently
  if (!allowList(account, h).includes(String(senderId))) {
    log?.info?.(`[dingtalk][herdr] denied /hd from ${senderId}`);
    return true;
  }

  const parts = text.trim().split(/\s+/);
  const sub = (parts[1] || "help").toLowerCase();
  const t = parts[2];
  // free text after the n-th token, original spacing and newlines kept
  const tail = (n: number) => {
    const m = text.trim().match(new RegExp(`^(?:\\S+\\s+){${n}}([\\s\\S]*)$`));
    return (m?.[1] ?? "").trim();
  };
  const md = (s: string, title: string) => reply(s, { markdown: true, title });
  const pk = pendingKey(account.accountId, String(senderId));
  try {
    switch (sub) {
      case "ls": case "list": case "agents":
        await md(mdLs(await bridge(h, "/ls")), "herdr 列表");
        break;
      case "read": {
        if (!t) { await reply("用法：/hd read <t> [行数]"); break; }
        const n = Math.min(Math.max(parseInt(parts[3] || "30", 10) || 30, 1), 120);
        const d = await bridge(h, "/read", { t, lines: n, history: n > 40 });
        if (!d.ok) { await reply(`❌ ${d.text || d.error}`); break; }
        await reply(`📟 ${t}\n${cleanScreen(d.text, n) || "（空屏）"}`);
        const st = (await bridge(h, "/ls")).terminals?.find((x: any) => x.t === t)?.status ?? null;
        await md(`${t} ${st ? STATE_TEXT[st] || st : ""}\n\n${actionsFor(t, st)} · ${cmdLink("更多", `/hd read ${t} 80`)}`, `${t} 操作`);
        break;
      }
      case "reply": case "r": {
        if (!t) { await reply("用法：/hd reply <t> [内容]"); break; }
        const body = tail(3);
        if (body) { // one step: send now
          const d = await bridge(h, "/send", { t, text: body });
          await md(d.ok ? `📨 已发给 ${t}\n\n${actionsFor(t, null)}` : `❌ ${JSON.stringify(d.out || d.error).slice(0, 300)}`, `已发给 ${t}`);
          break;
        }
        const d = await bridge(h, "/read", { t });
        if (!d.ok) { await reply(`❌ ${d.text || d.error}`); break; }
        pendingReply.set(pk, { t, until: Date.now() + REPLY_WINDOW_MS });
        await reply(`📟 ${t}\n${cleanScreen(d.text, 20) || "（空屏）"}`);
        await md(`✍️ 接下来你发的**一条**消息会转给 **${t}**（5 分钟内有效）\n\n${cmdLink("取消", "/hd cancel")}`, `回复 ${t}`);
        break;
      }
      case "cancel": {
        const had = pendingReply.delete(pk);
        await reply(had ? "已取消待回复" : "没有待回复的 agent");
        break;
      }
      case "send": case "s": {
        const body = tail(3);
        if (!t || !body) { await reply("用法：/hd send <t> <内容>"); break; }
        const d = await bridge(h, "/send", { t, text: body });
        await md(d.ok ? `📨 已发给 ${t}\n\n${actionsFor(t, null)}` : `❌ ${JSON.stringify(d.out || d.error).slice(0, 300)}`, `已发给 ${t}`);
        break;
      }
      case "ok": case "yes": case "approve": {
        if (!t) { await reply("用法：/hd ok <t> [选项]"); break; }
        const key = parts[3] || "enter";
        const d = await bridge(h, "/keys", { t, keys: [key] });
        await md(d.ok ? `👍 ${t} 已按 ${key}\n\n${actionsFor(t, null)}` : `❌ ${d.out || d.error}`, `${t} 已批准`);
        break;
      }
      case "trust": case "always": {
        if (!t) { await reply("用法：/hd trust <t>"); break; }
        const d = await bridge(h, "/trust", { t });
        await md(d.ok
          ? `🛡 ${t} 已选「${d.option}」（按 ${d.key}）\n\n${actionsFor(t, null)}`
          : `❌ 屏幕上没找到「不再询问 / 始终允许」选项${d.screen ? `\n\n${mdScreen(cleanScreen(d.screen, 8))}` : ""}\n\n${cmdLink("改为批准一次", `/hd ok ${t}`)} · ${cmdLink("读屏", `/hd read ${t}`)}`,
          `${t} 始终允许`);
        break;
      }
      case "no": case "esc": {
        if (!t) { await reply("用法：/hd no <t>"); break; }
        const d = await bridge(h, "/keys", { t, keys: ["esc"] });
        await md(d.ok ? `↩️ ${t} 已按 Esc\n\n${actionsFor(t, null)}` : `❌ ${d.out || d.error}`, `${t} 已拒绝`);
        break;
      }
      case "int": case "interrupt": case "stop": {
        if (!t) { await reply("用法：/hd int <t>"); break; }
        const d = await bridge(h, "/interrupt", { t });
        await md(d.ok ? `⏸ 已中断 ${t}\n\n${actionsFor(t, null)}` : `❌ ${JSON.stringify(d.out || d.error).slice(0, 300)}`, `${t} 已中断`);
        break;
      }
      case "kill": {
        if (!t) { await reply("用法：/hd kill <t>"); break; }
        const d = await bridge(h, "/kill", { t });
        await reply(d.ok ? `⏹ 已结束 ${t}` : `❌ ${d.out || d.error}`);
        break;
      }
      case "new": {
        const machine = parts[2], project = parts[3];
        let tplIdx = 4, template: string | undefined;
        if (/^(worker|advisor|verifier)(-codex)?$/i.test(parts[4] || "")) { template = parts[4].toLowerCase(); tplIdx = 5; }
        const task = tail(tplIdx);
        if (!machine || !project || !task) { await reply("用法：/hd new <机器> <项目> [模板] <任务>\n例：/hd new dev x3analyze 看下今天的工单有没有新告警"); break; }
        await reply(`⏳ 正在 ${machine} 的 ${project} 起 agent…`);
        const d = await bridge(h, "/new", { machine, project, template, task });
        await md(d.ok
          ? `🚀 已启动 **${d.address}**（${d.template}，${d.cwd}）\n\n完成或需要你时会推送\n\n${actionsFor(d.address, "working")}`
          : `❌ 启动失败：${d.error || JSON.stringify(d.out || d.sent).slice(0, 400)}`, d.ok ? `已启动 ${d.address}` : "启动失败");
        break;
      }
      case "digest": {
        const d = await bridge(h, "/digest");
        if (!d.ok) { await reply(`❌ ${d.error}`); break; }
        const rows = (d.agents || []).filter((a: any) => a.workingMin || a.blocks || a.turns);
        await md(rows.length
          ? [`#### 📊 ${d.date} agent 活动`, ...rows.map((a: any) => `- **${a.t}** ${a.app || ""} ${a.where || ""}：工作 ${a.workingMin} 分钟 · 卡住 ${a.blocks} 次 · 完成 ${a.turns} 轮`), "", cmdLink("列表", "/hd ls")].join("\n")
          : `📊 ${d.date} 还没有 agent 活动\n\n${cmdLink("列表", "/hd ls")}`, "今日活动");
        break;
      }
      default:
        await md(HELP_MD, "herdr 帮助");
    }
  } catch (err) {
    await reply(`❌ ${String((err as Error)?.message || err)}`);
  }
  log?.info?.(`[dingtalk][herdr] ${sub} ${t || ""}`);
  return true;
}

// ---------- push notifications ----------

function cursorFile(accountId: string): string {
  return resolveDingTalkCacheFile(`herdr-cursor-${accountId}.json`);
}
function readCursor(accountId: string): number | null {
  try { return JSON.parse(fs.readFileSync(cursorFile(accountId), "utf8")).after ?? null; } catch { return null; }
}
function writeCursor(accountId: string, after: number): void {
  const f = cursorFile(accountId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify({ after, at: new Date().toISOString() }));
  fs.renameSync(f + ".tmp", f);
}

export function startHerdrNotifier(params: { account: ResolvedDingTalkAccount; abortSignal?: AbortSignal; log?: any }): void {
  const { account, abortSignal, log } = params;
  const h = herdrConfig(account);
  if (!h || h.notify === false) return;
  const users = allowList(account, h);
  if (!users.length || !account.clientId || !account.clientSecret) {
    log?.warn?.("[dingtalk][herdr] notifier off: no allowFrom users or credentials");
    return;
  }
  const robotCode = account.robotCode || account.clientId;
  const every = Math.max(2, h.pollSeconds ?? 5) * 1000;
  let after = readCursor(account.accountId);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  abortSignal?.addEventListener("abort", () => { stopped = true; if (timer) clearTimeout(timer); }, { once: true });

  const tick = async () => {
    if (stopped) return;
    try {
      const d = await bridge(h, `/changes?after=${after ?? 0}`, undefined, 20_000);
      if (d.ok) {
        if (after === null) {
          after = d.last ?? 0; // first start: don't replay history
          writeCursor(account.accountId, after!);
        } else if (d.changes?.length) {
          const blocks: string[] = [];
          for (const c of d.changes) {
            const state = c.kind === "blocked" ? "blocked" : null;
            let s = `#### ${KIND_TEXT[c.kind] || c.kind} · ${c.t}\n\n${c.app || ""} · ${c.where || ""}${c.name ? ` · ${c.name}` : ""}`;
            if (c.msg) s += `\n\n${String(c.msg).slice(0, 200)}`;
            if (c.kind === "blocked" || c.kind === "turn_end" || c.kind === "done") {
              const r = await bridge(h, "/read", { t: c.t }, 25_000);
              const screen = r.ok ? cleanScreen(r.text, c.kind === "blocked" ? 14 : 8) : "";
              if (screen) s += `\n\n${mdScreen(screen)}`;
            }
            if (c.kind !== "exited") s += `\n\n${actionsFor(c.t, state)}`;
            blocks.push(s);
          }
          const first = d.changes[0];
          const title = `${KIND_TEXT[first.kind] || first.kind} ${first.t}${d.changes.length > 1 ? ` 等 ${d.changes.length} 条` : ""}`;
          const text = blocks.join("\n\n---\n\n").slice(0, 5000) + `\n\n${cmdLink("列表", "/hd ls")}`;
          let delivered = true;
          for (const userId of users) {
            const r = await sendDMMessageWithKey({ clientId: account.clientId!, clientSecret: account.clientSecret!, robotCode, userId, text, format: "markdown", title });
            if (!r.ok) { delivered = false; log?.warn?.(`[dingtalk][herdr] push to ${userId} failed: ${r.error}`); }
          }
          // advance even on partial failure after a retry window, so one bad user can't wedge the queue
          if (delivered || (Date.now() - (first.at || 0)) > 10 * 60_000) {
            after = d.changes[d.changes.length - 1].id;
            writeCursor(account.accountId, after!);
          }
        }
      }
    } catch (err) {
      log?.warn?.(`[dingtalk][herdr] poll error: ${String(err)}`);
    }
    if (!stopped) timer = setTimeout(tick, every);
  };
  log?.info?.(`[dingtalk][herdr] notifier on for account ${account.accountId} → ${users.length} user(s), every ${every / 1000}s`);
  timer = setTimeout(tick, 1000);
}
