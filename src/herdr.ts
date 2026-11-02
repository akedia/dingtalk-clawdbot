/**
 * herdr remote control over DingTalk DMs.
 *
 * `/hd ...` commands from allow-listed staffIds (DM only, one configured account)
 * are answered directly — they never reach the AI agent. Agent status changes
 * (blocked / error / turn finished / exited) are pushed to the same people.
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

const CMD_RE = /^\/hd(\s|$)/i;
const SCREEN_MAX = 3000;

export function isHerdrCommand(text: string): boolean {
  return CMD_RE.test(text.trim());
}

/** Commands with effects; these go through content dedup so a redelivery can't run them twice. */
export function isHerdrWriteCommand(text: string): boolean {
  const sub = (text.trim().split(/\s+/)[1] || "").toLowerCase();
  return ["send", "s", "ok", "yes", "approve", "no", "esc", "int", "interrupt", "stop", "kill", "new"].includes(sub);
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
const KIND_TEXT: Record<string, string> = {
  blocked: "🔴 需要你处理", error: "❌ 出错", done: "✅ 完成", turn_end: "✅ 本轮完成", exited: "⏹ 已退出",
};

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

function fmtLs(d: any): string {
  if (!d.ok) return `❌ ${d.error || d.out || "ls failed"}`;
  const machines = (d.machines || []).map((m: any) => `${m.name}:${m.state === "connected" ? "在线" : m.state}`).join("  ");
  const rows = (d.terminals || []).map((t: any) => {
    const icon = t.status ? (STATE_ICON[t.status] || "•") : "▫️";
    const what = t.app || t.agent || "";
    const label = t.name ? ` (${t.name})` : "";
    const msg = t.msg ? `  ${String(t.msg).slice(0, 60)}` : "";
    return `${icon} ${t.t}${label}  ${what}  ${t.where || t.cwd || ""}${msg}`;
  });
  return [`机器  ${machines || "仅本机"}`, ...(rows.length ? rows : ["（没有终端）"])].join("\n");
}

const HELP = [
  "herdr 遥控（只认私聊）",
  "/hd ls                       列出所有终端和 agent 状态",
  "/hd read <t> [行数]          读屏，默认 30 行",
  "/hd send <t> <内容>          发给 agent（贴入并回车）",
  "/hd ok <t> [选项]            批准：默认回车，或按 1/2/y",
  "/hd no <t>                   拒绝/返回（Esc）",
  "/hd int <t>                  中断当前回合（Ctrl+C）",
  "/hd new <机器> <项目> [模板] <任务>   起新 agent",
  "/hd kill <t>                 结束终端",
  "/hd digest                   今日工作时长 / 卡住次数",
  "<t> 用 /hd ls 里的地址，如 dev/t12 或 v172/t5，也可用名字",
  "机器: dev（默认 Codex）· v172（默认 Claude）；项目: x3analyze / grfal / skills",
  "模板: worker advisor verifier，加 -codex 用 Codex",
].join("\n");

// ---------- commands ----------

export async function handleHerdrCommand(params: {
  account: ResolvedDingTalkAccount;
  senderId: string;
  isDm: boolean;
  text: string;
  reply: (text: string) => Promise<unknown>;
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
  const rest = (n: number) => text.trim().split(/\s+/).slice(n).join(" ").trim();
  // keep the original spacing/newlines of free text after the n-th token
  const tail = (n: number) => {
    const m = text.trim().match(new RegExp(`^(?:\\S+\\s+){${n}}([\\s\\S]*)$`));
    return (m?.[1] ?? "").trim();
  };
  let out: string;
  try {
    switch (sub) {
      case "ls": case "list": case "agents":
        out = fmtLs(await bridge(h, "/ls"));
        break;
      case "read": case "r": {
        if (!t) { out = "用法：/hd read <t> [行数]"; break; }
        const n = Math.min(Math.max(parseInt(parts[3] || "30", 10) || 30, 1), 120);
        const d = await bridge(h, "/read", { t, lines: n + 20 });
        out = d.ok ? `📟 ${t}\n${cleanScreen(d.text, n) || "（空屏）"}` : `❌ ${d.text || d.error}`;
        break;
      }
      case "send": case "s": {
        const body = tail(3);
        if (!t || !body) { out = "用法：/hd send <t> <内容>"; break; }
        const d = await bridge(h, "/send", { t, text: body });
        out = d.ok ? `📨 已发给 ${t}` : `❌ ${JSON.stringify(d.out || d.error).slice(0, 300)}`;
        break;
      }
      case "ok": case "yes": case "approve": {
        if (!t) { out = "用法：/hd ok <t> [选项]"; break; }
        const key = parts[3] || "enter";
        const d = await bridge(h, "/keys", { t, keys: [key] });
        out = d.ok ? `👍 ${t} 已按 ${key}` : `❌ ${d.out || d.error}`;
        break;
      }
      case "no": case "esc": {
        if (!t) { out = "用法：/hd no <t>"; break; }
        const d = await bridge(h, "/keys", { t, keys: ["esc"] });
        out = d.ok ? `↩️ ${t} 已按 Esc` : `❌ ${d.out || d.error}`;
        break;
      }
      case "int": case "interrupt": case "stop": {
        if (!t) { out = "用法：/hd int <t>"; break; }
        const d = await bridge(h, "/interrupt", { t });
        out = d.ok ? `⏸ 已中断 ${t}` : `❌ ${JSON.stringify(d.out || d.error).slice(0, 300)}`;
        break;
      }
      case "kill": {
        if (!t) { out = "用法：/hd kill <t>"; break; }
        const d = await bridge(h, "/kill", { t });
        out = d.ok ? `⏹ 已结束 ${t}` : `❌ ${d.out || d.error}`;
        break;
      }
      case "new": {
        const machine = parts[2], project = parts[3];
        let tplIdx = 4, template: string | undefined;
        if (/^(worker|advisor|verifier)(-codex)?$/i.test(parts[4] || "")) { template = parts[4].toLowerCase(); tplIdx = 5; }
        const task = tail(tplIdx);
        if (!machine || !project || !task) { out = "用法：/hd new <机器> <项目> [模板] <任务>\n例：/hd new dev x3analyze 看下今天的工单有没有新告警"; break; }
        await reply(`⏳ 正在 ${machine} 的 ${project} 起 agent…`);
        const d = await bridge(h, "/new", { machine, project, template, task });
        out = d.ok
          ? `🚀 已启动 ${d.address}（${d.template}，${d.cwd}）\n完成或需要你时会推送；查看：/hd read ${d.address}`
          : `❌ 启动失败：${d.error || JSON.stringify(d.out || d.sent).slice(0, 400)}`;
        break;
      }
      case "digest": {
        const d = await bridge(h, "/digest");
        if (!d.ok) { out = `❌ ${d.error}`; break; }
        const rows = (d.agents || []).filter((a: any) => a.workingMin || a.blocks || a.turns);
        out = rows.length
          ? [`📊 ${d.date} agent 活动`, ...rows.map((a: any) => `${a.t} ${a.app || ""} ${a.where || ""}  工作 ${a.workingMin} 分钟 · 卡住 ${a.blocks} 次 · 完成 ${a.turns} 轮`)].join("\n")
          : `📊 ${d.date} 还没有 agent 活动`;
        break;
      }
      default:
        out = HELP;
    }
  } catch (err) {
    out = `❌ ${String((err as Error)?.message || err)}`;
  }
  await reply(out);
  log?.info?.(`[dingtalk][herdr] ${sub} ${rest(2).slice(0, 60)}`);
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
          const lines: string[] = [];
          for (const c of d.changes) {
            let s = `${KIND_TEXT[c.kind] || c.kind}  ${c.t}${c.name ? ` (${c.name})` : ""}  ${c.app || ""}  ${c.where || ""}`;
            if (c.msg) s += `\n${String(c.msg).slice(0, 200)}`;
            if (c.kind === "blocked" || c.kind === "turn_end" || c.kind === "done") {
              const r = await bridge(h, "/read", { t: c.t, lines: 40 }, 20_000);
              const screen = r.ok ? cleanScreen(r.text, c.kind === "blocked" ? 14 : 8) : "";
              if (screen) s += `\n┄┄┄\n${screen}`;
            }
            if (c.kind === "blocked") s += `\n→ /hd ok ${c.t} 批准 · /hd read ${c.t} 看全屏`;
            lines.push(s);
          }
          const text = lines.join("\n\n").slice(0, 6000);
          let delivered = true;
          for (const userId of users) {
            const r = await sendDMMessageWithKey({ clientId: account.clientId!, clientSecret: account.clientSecret!, robotCode, userId, text, format: "text" });
            if (!r.ok) { delivered = false; log?.warn?.(`[dingtalk][herdr] push to ${userId} failed: ${r.error}`); }
          }
          // advance even on partial failure after one retry window, so one bad user can't wedge the queue
          if (delivered || (Date.now() - (d.changes[0].at || 0)) > 10 * 60_000) {
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
