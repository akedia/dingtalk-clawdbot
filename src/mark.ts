/**
 * x3 Mark over DingTalk DMs: a screenshot (or video / voice) plus a sentence becomes a read-only
 * Claude investigation on an x3 machine (x3analyze qa/mark/mark.py), and its verdict is pushed back.
 *
 *   /mark <描述> [role=角色 server=服 env=beta|dev|prod]   open a draft; the next 5 minutes of pictures,
 *                                                          videos, files, voice and text join it
 *   /mark live [mumu|editor] <描述>                         also capture the running MuMu / Editor
 *   好了 | /mark go                                         submit now (60 s of quiet submits too)
 *   /mark ls · /mark <id> · /mark ask <id> <问题> · /mark cancel [id]
 *
 * Same allow-list, account and bridge as `/hd` (channels.dingtalk.herdr); never in groups. Files the
 * plugin already downloaded are read here and sent to herdr-bridge, which scp's them to the machine.
 */
import * as fs from "fs";
import * as path from "path";
import type { ResolvedDingTalkAccount } from "./types.js";

export type MarkReply = (text: string, opts?: { markdown?: boolean; title?: string }) => Promise<unknown>;

interface BridgeCfg { enabled?: boolean; account?: string; bridgeUrl?: string; token?: string; allowFrom?: string[] }

interface Draft {
  notes: string[];
  voice: string[];
  files: string[];
  opts: Record<string, string>;
  started: number;
  timer?: NodeJS.Timeout;
  reply: MarkReply;
  log?: any;
  h: BridgeCfg;
}

const CMD_RE = /^\/mark(\s|$)/i;
const PIC_RE = /\[图片:\s*([^\]\n]+?)\s*\]/g;
const GO_RE = /^(好了|好|完了|完成|提交|发吧|就这些|go|ok|done)$/i;
const CANCEL_RE = /^(取消|算了|不要了|cancel)$/i;
const ID_RE = /^#?([0-9a-f]{4})$/i;
const IDLE_MS = 60_000;
const WINDOW_MS = 5 * 60_000;
const MAX_BYTES = 38 << 20;
const MAX_FILES = 12;
const drafts = new Map<string, Draft>();

export function isMarkCommand(text: string): boolean {
  return CMD_RE.test(String(text || "").trim());
}

function markConfig(account: ResolvedDingTalkAccount): BridgeCfg | null {
  const h = (account.config as any)?.herdr as BridgeCfg | undefined;
  if (!h || h.enabled === false || !h.token) return null;
  if ((h.account ?? "default") !== account.accountId) return null;
  return h;
}

function allowed(account: ResolvedDingTalkAccount, h: BridgeCfg, senderId: string): boolean {
  const list = (h.allowFrom?.length ? h.allowFrom : ((account.config as any)?.dm?.allowFrom ?? [])).map(String);
  return list.filter((s: string) => s && s !== "*").includes(String(senderId));
}

async function markBridge(h: BridgeCfg, p: string, body: unknown, timeoutMs = 150_000): Promise<any> {
  const url = (h.bridgeUrl || "http://127.0.0.1:8377").replace(/\/$/, "") + p;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
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

/** `role=1 server=2 env=beta serial=x` tokens out of a note; the rest stays the note. */
export function parseOpts(text: string): { note: string; opts: Record<string, string> } {
  const opts: Record<string, string> = {};
  const note = text.replace(/(?<![\w\u4e00-\u9fff])(role|server|env|serial|角色|服)\s*[=:：]\s*([\w.:-]+)/gi, (_m, k: string, v: string) => {
    const key = ({ 角色: "role", 服: "server" } as Record<string, string>)[k] || k.toLowerCase();
    opts[key] = v;
    return " ";
  }).replace(/\s+/g, " ").trim();
  return { note, opts };
}

/** Picture paths the plugin embedded in a rich-text body as `[图片: /path]`, and the text without them. */
export function splitPictures(text: string): { text: string; pictures: string[] } {
  const pictures: string[] = [];
  const rest = String(text || "").replace(PIC_RE, (_m, p: string) => { pictures.push(p.trim()); return " "; });
  return { text: rest.replace(/\s+/g, " ").trim(), pictures };
}

const key = (account: ResolvedDingTalkAccount, senderId: string) => `${account.accountId}:${senderId}`;

function arm(k: string, d: Draft) {
  if (d.timer) clearTimeout(d.timer);
  const left = Math.max(1000, Math.min(IDLE_MS, d.started + WINDOW_MS - Date.now()));
  d.timer = setTimeout(() => { void submit(k, "auto"); }, left);
}

async function submit(k: string, why: "auto" | "go" | "inline"): Promise<void> {
  const d = drafts.get(k);
  if (!d) return;
  drafts.delete(k);
  if (d.timer) clearTimeout(d.timer);
  if (!d.notes.length && !d.voice.length && !d.files.length) {
    if (why !== "auto") await d.reply("这一单什么都没有，没提交。");
    return;
  }
  const files: { name: string; b64: string }[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of d.files.slice(0, MAX_FILES)) {
    try {
      const buf = fs.readFileSync(f);
      if (total + buf.length > MAX_BYTES) { skipped.push(path.basename(f)); continue; }
      total += buf.length;
      files.push({ name: path.basename(f), b64: buf.toString("base64") });
    } catch {
      skipped.push(path.basename(f));
    }
  }
  if (d.files.length > MAX_FILES) skipped.push(`另 ${d.files.length - MAX_FILES} 个`);
  const r = await markBridge(d.h, "/mark/new", {
    note: d.notes.join("\n"), voice_text: d.voice.join("\n"), files,
    role: d.opts.role, server: d.opts.server, env: d.opts.env, live: d.opts.live, serial: d.opts.serial,
  }, 240_000);
  if (!r.ok) {
    await d.reply(`❌ Mark 没提交成功：${String(r.error || "未知错误").slice(0, 300)}\n\n原话和附件还在，重发 \`/mark ...\` 即可。`, { markdown: true, title: "Mark 提交失败" });
    return;
  }
  const m = r.mark || {};
  const extra = skipped.length ? `\n\n⚠ 没带上：${skipped.join("、")}（读不到或超过 ${MAX_BYTES >> 20} MB）` : "";
  await d.reply(`🔍 **Mark #${m.short}** 已提交（${files.length} 个附件${d.voice.length ? "，含语音" : ""}${d.opts.live ? `，现场 ${d.opts.live}` : ""}），`
    + `排查中，一般几分钟，完成后推送。\n\n查看进度 \`/mark ${m.short}\` · 取消 \`/mark cancel ${m.short}\`${extra}`,
    { markdown: true, title: `Mark #${m.short} 已提交` });
  d.log?.info?.(`[dingtalk][mark] submitted #${m.short} (${files.length} files, ${total} bytes, ${why})`);
}

const STATE_TEXT: Record<string, string> = {
  received: "已收到", capturing: "采集现场", queued: "排队中", investigating: "排查中", done: "完成", failed: "失败",
};

function mdShow(m: any, max = 3800): string {
  const head = [`#### Mark #${m.short} · ${STATE_TEXT[m.state] || m.state}${m.verdict ? ` · **${m.verdict}**` : ""}`];
  if (m.summary) head.push(`> ${m.summary}`);
  if (m.note) head.push(`原话：${String(m.note).slice(0, 200)}`);
  if (m.error) head.push(`❌ ${String(m.error).slice(0, 300)}`);
  const body = m.report ? String(m.report).replace(/^\s*结论[:：].*\n?/, "").replace(/^\s*摘要[:：].*\n?/, "").trim() : "";
  const parts = [head.join("\n\n")];
  if (body) parts.push(body.length > max ? body.slice(0, max) + `\n\n…（全文 ${body.length} 字，见报告文件）` : body);
  for (const fu of m.followups || []) {
    parts.push(`**追问 ${fu.n}**：${String(fu.q).slice(0, 120)}\n\n${fu.state === "done" ? `> ${fu.summary || ""}` : STATE_TEXT[fu.state] || fu.state}`);
  }
  return parts.join("\n\n");
}

function help(): string {
  return [
    "#### 📝 x3 Mark：截图 + 一句话 → Claude 只读排查",
    "- `/mark 描述` 开单，接着 5 分钟内发截图 / 录屏 / 语音 / 补充文字，回 **好了** 提交（60 秒没新消息也会自动提交）",
    "- 图文一起发（富文本里带 `/mark 描述`）会直接提交",
    "- 可带 `role=角色ID server=服ID env=beta|dev|prod`",
    "- `/mark live 描述`：顺带抓 172 上 MuMu 正在跑的游戏（`live editor` 抓 Editor）",
    "- `/mark ls` 最近 · `/mark <4位号>` 详情 · `/mark ask <号> 问题` 追问 · `/mark cancel [号]` 取消",
    "- 完成推送后 **引用那条回复** = 追问；回 **看** = 全文",
  ].join("\n");
}

export async function handleMarkCommand(params: {
  account: ResolvedDingTalkAccount; senderId: string; isDm: boolean; text: string; reply: MarkReply; log?: any;
}): Promise<boolean> {
  const { account, senderId, isDm, reply, log } = params;
  if (!isMarkCommand(params.text)) return false;
  const h = markConfig(account);
  if (!h) return false;
  if (!isDm) return true;
  if (!allowed(account, h, senderId)) { log?.info?.(`[dingtalk][mark] denied /mark from ${senderId}`); return true; }
  const k = key(account, senderId);
  const { text: plain, pictures } = splitPictures(params.text.trim().replace(CMD_RE, "").trim());
  const words = plain.split(/\s+/).filter(Boolean);
  const sub = (words[0] || "").toLowerCase();

  if (!words.length && !pictures.length || sub === "help" || sub === "?") { await reply(help(), { markdown: true, title: "Mark 用法" }); return true; }
  if (sub === "ls" || sub === "list") {
    const r = await markBridge(h, "/mark/ls", { n: 10 });
    if (!r.ok) { await reply(`❌ ${r.error}`); return true; }
    const rows = (r.data || []).map((m: any) => `- **#${m.short}** ${STATE_TEXT[m.state] || m.state}${m.verdict ? `·${m.verdict}` : ""}${m.stale ? "（进程已不在）" : ""} — ${String(m.summary || m.note || "").slice(0, 60)}`);
    await reply(rows.length ? `#### 最近的 Mark\n\n${rows.join("\n")}` : "还没有 Mark。", { markdown: true, title: "Mark 列表" });
    return true;
  }
  if (sub === "go" || sub === "submit") {
    if (!drafts.has(k)) { await reply("没有开着的 Mark，先发 `/mark 描述`。"); return true; }
    await submit(k, "go");
    return true;
  }
  if (sub === "cancel") {
    const id = words[1]?.match(ID_RE)?.[1];
    if (!id) {
      const had = drafts.get(k);
      if (had?.timer) clearTimeout(had.timer);
      drafts.delete(k);
      await reply(had ? "已丢弃这一单（还没提交）。" : "没有开着的 Mark；取消已提交的用 `/mark cancel <号>`。");
      return true;
    }
    const r = await markBridge(h, "/mark/cancel", { id });
    await reply(r.ok ? `已取消 Mark #${id}。` : `❌ ${r.error}`);
    return true;
  }
  if (sub === "ask") {
    const id = words[1]?.match(ID_RE)?.[1];
    const q = words.slice(2).join(" ");
    if (!id || !q) { await reply("用法：`/mark ask <4位号> 问题`，或引用完成推送直接回复。"); return true; }
    const r = await markBridge(h, "/mark/ask", { id, text: q });
    await reply(r.ok ? `💬 已追问 Mark #${id}，回答好了推送给你。` : `❌ ${r.error}`);
    return true;
  }
  const idOnly = words.length === 1 && !pictures.length ? sub.match(ID_RE)?.[1] : undefined;
  if (idOnly) {
    const r = await markBridge(h, "/mark/show", { id: idOnly });
    await reply(r.ok ? mdShow(r.data) : `❌ ${r.error}`, { markdown: true, title: `Mark #${idOnly}` });
    return true;
  }

  // a new draft
  const opts: Record<string, string> = {};
  let rest = plain;
  const live = rest.match(/^live(?:\s+(mumu|editor))?\b\s*/i);
  if (live) { opts.live = (live[1] || "mumu").toLowerCase(); rest = rest.slice(live[0].length); }
  const parsed = parseOpts(rest);
  Object.assign(opts, parsed.opts);
  const old = drafts.get(k);
  if (old?.timer) clearTimeout(old.timer);
  const d: Draft = { notes: parsed.note ? [parsed.note] : [], voice: [], files: [...pictures], opts, started: Date.now(), reply, log, h };
  drafts.set(k, d);
  if (pictures.length) { await submit(k, "inline"); return true; }
  arm(k, d);
  await reply(`📝 **Mark 已开单**${opts.live ? `（现场：${opts.live}）` : ""}：${parsed.note || "（还没有描述）"}\n\n`
    + "接下来 5 分钟内发的 **截图 / 录屏 / 文件 / 语音 / 补充文字** 都归到这一单；发完回 **好了**，60 秒没新消息也会自动提交。回 **取消** 丢弃。",
    { markdown: true, title: "Mark 已开单" });
  return true;
}

/**
 * A DM while a draft is open: attach it (picture / video / file path, voice text, extra words)
 * instead of letting it reach the AI. Returns true when consumed.
 */
export async function handleMarkDraftMessage(params: {
  account: ResolvedDingTalkAccount; senderId: string; isDm: boolean; text: string; mediaPath?: string;
  messageType?: string; reply: MarkReply; log?: any;
}): Promise<boolean> {
  const { account, senderId, isDm } = params;
  if (!isDm) return false;
  const k = key(account, senderId);
  const d = drafts.get(k);
  if (!d) return false;
  if (Date.now() - d.started > WINDOW_MS + 30_000) { await submit(k, "auto"); return false; }
  const raw = String(params.text || "").trim();
  if (GO_RE.test(raw)) { await submit(k, "go"); return true; }
  if (CANCEL_RE.test(raw)) {
    if (d.timer) clearTimeout(d.timer);
    drafts.delete(k);
    await params.reply("已丢弃这一单（还没提交）。");
    return true;
  }
  const { text, pictures } = splitPictures(raw);
  let got = 0;
  for (const p of pictures) { d.files.push(p); got++; }
  if (params.mediaPath) { d.files.push(params.mediaPath); got++; }
  if (params.messageType === "audio" && text) d.voice.push(text);
  else if (text && !params.mediaPath && !/^\[(picture|video|file|audio)\]/.test(text)) {
    const parsed = parseOpts(text);
    Object.assign(d.opts, parsed.opts);
    if (parsed.note) d.notes.push(parsed.note);
  }
  arm(k, d);
  const what = got ? `📎 已收 ${d.files.length} 个附件` : params.messageType === "audio" ? "🎙 已收语音" : "✏ 已记下";
  await params.reply(`${what}，继续发或回 **好了** 提交。`, { markdown: true, title: "Mark" });
  return true;
}

/** A push about a mark, as a message (the notifier adds the full report as a file when present). */
export async function markNotice(h: BridgeCfg, c: any): Promise<{ text: string; title: string; file?: { name: string; text: string } }> {
  const r = await markBridge(h, "/mark/show", { machine: c.machine, id: c.mark }, 60_000);
  const m = r.ok ? r.data : { short: c.mark, state: c.event === "failed" ? "failed" : "done", verdict: c.verdict, summary: c.summary, note: c.note, error: c.error };
  if (c.event === "answer" || c.event === "answer_failed") {
    const fu = (m.followups || []).find((x: any) => x.n === c.followup) || {};
    const ans = String(fu.answer || "").replace(/^\*\*追问\*\*.*\n+/, "").trim();
    return {
      text: `#### 💬 Mark #${c.mark} 追问 ${c.followup}\n\n你：${String(c.q || fu.q || "").slice(0, 160)}\n\n`
        + (c.event === "answer" ? (ans.length > 3800 ? ans.slice(0, 3800) + "\n\n…（见文件）" : ans) : `❌ ${c.error || fu.error || "失败"}`)
        + "\n\n↩ 引用本条回复 = 继续追问",
      title: `Mark #${c.mark} 追问回答`,
      file: ans.length > 3800 ? { name: `mark-${c.mark}-ask${c.followup}.md`, text: ans } : undefined,
    };
  }
  const icon = c.event === "failed" ? "❌" : ({ 已定位: "✅", 非问题: "🟢", 需更多信息: "🟡", 未查明: "⚪" } as Record<string, string>)[m.verdict] || "✅";
  const text = `${icon} ` + mdShow(m) + (c.event === "failed" ? "" : "\n\n↩ 引用本条回复 = 追问 · 回 **看** = 全文");
  return {
    text: text.slice(0, 5000),
    title: `${icon} Mark #${c.mark} ${m.verdict || (c.event === "failed" ? "失败" : "")}：${String(m.summary || m.note || "").slice(0, 30)}`,
    file: m.report && String(m.report).length > 3800 ? { name: `mark-${c.mark}-report.md`, text: String(m.report) } : undefined,
  };
}

/** A quote-reply to a mark push: "看" shows it, anything else is a follow-up question. */
export async function handleMarkQuote(params: {
  account: ResolvedDingTalkAccount; senderId: string; isDm: boolean; text: string; mark: { id: string; machine?: string };
  reply: MarkReply; log?: any;
}): Promise<boolean> {
  const { mark } = params;
  const body = String(params.text || "").replace(/^\[引用[^\]\n]*\]\s*/, "").trim();
  if (!body) return false;
  if (/^(看|看看|全文|详情|read|r)$/i.test(body)) return handleMarkCommand({ ...params, text: `/mark ${mark.id}` });
  return handleMarkCommand({ ...params, text: `/mark ask ${mark.id} ${body}` });
}

export function _resetMarkDrafts(): void {
  for (const d of drafts.values()) if (d.timer) clearTimeout(d.timer);
  drafts.clear();
}
