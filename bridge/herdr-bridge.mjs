#!/usr/bin/env node
// herdr-bridge: a narrow, token-guarded HTTP front for one machine's `hc`.
// The DingTalk plugin calls it; it never exposes files or arbitrary `hc exec` — the only exec is
// each agent machine's own Agent Hub (machines.<m>.hub) with a fixed set of subcommands.
//
//   GET  /health                      ok + machines
//   GET  /ls                          agents and terminals (live)
//   POST /read      {t, lines}        screen text
//   POST /send      {t, text}         paste + enter
//   POST /keys      {t, keys[], expect?}  keys (enter, esc, 1, y, ctrl+c ...)
//   POST /trust     {t, expect?}      pick the prompt's "don't ask again / always" option
//   POST /interrupt {t}
//   POST /new       {machine, project|cwd, template?, task}
//   POST /kill      {t}
//   GET  /changes?after=N             status changes worth a push (durable ids)
//   GET  /digest                      today's working time / blocks / turns per agent
//   POST /task/machines|contexts|ls|new|show|followup|control|decide   Agent Hub tasks (below)
//
// Agent Hub: every 30 s (hubPollSeconds) the bridge runs `advance` and reads `outbox` on each
// machine with a hub; each notice becomes a `task` change (same push cursor), then is acked.
//
// Every blocked episode gets a prompt id (/ls `prompt`, change `prompt`). A key sent with
// `expect` is refused unless the agent is still blocked on that same prompt, so a choice made
// on an old push can't land on a newer question or hit a working agent.
//
// Config: ~/.config/herdr-bridge/config.json   State: ~/.local/state/herdr-bridge/state.json
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';

const HOME = os.homedir();
const CONFIG_PATH = process.env.HERDR_BRIDGE_CONFIG || path.join(HOME, '.config/herdr-bridge/config.json');
const STATE_PATH = process.env.HERDR_BRIDGE_STATE || path.join(HOME, '.local/state/herdr-bridge/state.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const HC = cfg.hc || path.join(HOME, '.local/bin/hc');
const PORT = cfg.port || 8377;
const TOKEN = String(cfg.token || '');
if (TOKEN.length < 24) throw new Error('config.token must be at least 24 chars');
const NOTIFY_STATES = new Set(cfg.notifyStates || ['blocked', 'error', 'done', 'turn_end', 'exited']);
const MAX_CHANGES = 500;
const MAX_FINISHED = 500;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- state (durable change ids + per-agent last state + daily digest) ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
const st = Object.assign({ nextId: 1, changes: [], last: {}, day: null, prompts: {}, promptSeq: 0, finished: {}, hubSeen: {} }, loadState());
let saveTimer = null;
function writeState() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, STATE_PATH);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeState, 300);
}
function saveNow() { clearTimeout(saveTimer); writeState(); }
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // Asia/Shanghai date
function dayBucket(addr) {
  if (!st.day || st.day.date !== today()) st.day = { date: today(), agents: {} };
  return (st.day.agents[addr] ||= { workingMs: 0, blocks: 0, turns: 0, app: null, where: null });
}

// ---------- hc ----------
function hc(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(HC, args, { cwd: HOME, timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout), err: String(stderr) });
    });
  });
}
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---------- live view from `hc events` ----------
const terms = new Map(); // address -> record (status, labels, name, cwd, state, argv, foreground)
function addrOf(p) {
  const a = p.terminal || p.data?.address;
  return p.machine && a && !a.includes('/') ? `${p.machine}/${a}` : a;
}
function whereOf(r) { return r?.labels?.where || r?.name || r?.cwd || ''; }
function appOf(r) { return r?.status?.app || r?.foreground?.name || (r?.argv || [])[0] || ''; }

function noteChange(addr, kind, extra = {}) {
  const r = terms.get(addr) || {};
  const ch = { id: st.nextId++, at: Date.now(), t: addr, kind, app: appOf(r), where: whereOf(r), name: r.name || null, ...extra };
  st.changes.push(ch);
  if (st.changes.length > MAX_CHANGES) st.changes.splice(0, st.changes.length - MAX_CHANGES);
  save();
  log('change', JSON.stringify(ch));
}

const promptKey = (s) => `${s?.kind || ''}|${s?.msg || ''}`;

// Terminals whose process ended: keys for them are refused as `finished` until the address
// reports a real status again or is created/restarted. Insertion-ordered, newest MAX_FINISHED kept.
function clearFinished(addr) {
  if (!Object.hasOwn(st.finished, addr)) return;
  delete st.finished[addr];
  save();
}

/** Forget the live state and remember the address as finished. `refresh` moves it to the newest end. */
function markFinished(addr, refresh) {
  delete st.last[addr]; delete st.prompts[addr];
  if (refresh || !Object.hasOwn(st.finished, addr)) {
    delete st.finished[addr];
    st.finished[addr] = Date.now();
    const keys = Object.keys(st.finished);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FINISHED))) delete st.finished[k];
  }
  save();
}

export function noteFinished(addr, data = {}) {
  const r = terms.get(addr);
  const wasAgent = r && (r.reported || st.last[addr]?.state);
  if (r) { r.state = 'finished'; r.exit_code = data.exit_code; }
  if (wasAgent && NOTIFY_STATES.has('exited')) noteChange(addr, 'exited', { exit_code: data.exit_code, reason: data.reason });
  markFinished(addr, true);
}

export function applyStatus(addr, status, silent) {
  if (status?.state) clearFinished(addr); // a finished terminal reports status null: keep the mark
  const prev = st.last[addr] || { state: null, since: Date.now() };
  const next = status?.state || null;
  // a new question: entering blocked, or still blocked but asking something else
  const newAsk = next === 'blocked' && (prev.state !== 'blocked' || st.prompts[addr]?.key !== promptKey(status));
  if (prev.state === next && !newAsk) return;
  const now = Date.now();
  const b = dayBucket(addr);
  const r = terms.get(addr);
  b.app = appOf(r) || b.app; b.where = whereOf(r) || b.where;
  if (prev.state !== next) {
    if (prev.state === 'working') b.workingMs += now - (prev.since || now);
    st.last[addr] = { state: next, since: now };
  }
  if (newAsk) {
    b.blocks++;
    st.prompts[addr] = { id: ++st.promptSeq, key: promptKey(status), at: now };
  } else if (next !== 'blocked') delete st.prompts[addr];
  if (!silent) {
    if (newAsk && NOTIFY_STATES.has('blocked')) noteChange(addr, 'blocked', { msg: status?.msg || null, prompt: st.prompts[addr].id });
    else if (next === 'error' && NOTIFY_STATES.has('error')) noteChange(addr, 'error', { msg: status?.msg || null });
    else if (next === 'done' && NOTIFY_STATES.has('done')) { b.turns++; noteChange(addr, 'done'); }
    else if (prev.state === 'working' && next === 'idle' && NOTIFY_STATES.has('turn_end')) { b.turns++; noteChange(addr, 'turn_end'); }
  }
  save();
}

// Full view after a (re)connect or `missed`. Terminals already finished are marked silently:
// no exited push and no digest counts — the live `finished` event (if we saw it) did that.
export function snapshot(list, silent = true) {
  terms.clear();
  for (const r of list || []) terms.set(r.address, r);
  for (const [a, r] of terms) {
    if (r.state === 'finished') markFinished(a, false);
    else if (r.status !== undefined) applyStatus(a, r.status, silent);
  }
}

let evProc = null, backoff = 1000;
function startEvents() {
  evProc = spawn(HC, ['events', '--json'], { cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: evProc.stdout });
  let first = true;
  rl.on('line', (line) => {
    const m = parse(line); if (!m) return;
    if (first && Array.isArray(m.terminals)) { first = false; snapshot(m.terminals, true); backoff = 1000; log('snapshot', terms.size); return; }
    if (m.method === 'missed') { snapshot(m.params?.terminals, true); return; }
    if (m.method !== 'event') return;
    const p = m.params || {}; const addr = addrOf(p); if (!addr) return;
    const d = p.data || {};
    switch (p.type) {
      case 'created': case 'restarted': terms.set(addr, { ...d, address: addr }); clearFinished(addr); break;
      case 'removed': terms.delete(addr); break;
      case 'status': { const r = terms.get(addr) || { address: addr }; r.status = d.status; terms.set(addr, r); applyStatus(addr, d.status, false); break; }
      case 'labels': { const r = terms.get(addr); if (r) r.labels = d.labels; break; }
      case 'foreground': { const r = terms.get(addr); if (r) r.foreground = d; break; }
      case 'finished': noteFinished(addr, d); break;
    }
  });
  evProc.stderr.on('data', (b) => log('events stderr', String(b).trim()));
  evProc.on('exit', (code) => {
    log('events exited', code, 'restart in', backoff);
    setTimeout(startEvents, backoff); backoff = Math.min(backoff * 2, 60000);
  });
}

// ---------- operations ----------
const CODEX_RULES = {
  'worker-codex': 'You received a handoff with zero context; read the named files first. Keep the task semantics (investigate-only = no edits). Verify with the named commands before calling it done. Do not start other agents unless told.',
  'advisor-codex': 'You are an advisor giving a second opinion; read the named files first. Give a recommendation with reasoning. This is analysis only. Do NOT edit, create, or delete any files. Do NOT write code. Do NOT start other agents.',
  'verifier-codex': 'You are a verifier: check facts against the definition of done, cite commands and outputs, do not edit. The first word of your report must be DONE or NOT-DONE.',
};
// "2. Yes, and don't ask again for Bash(npm test:*)" (Claude Code), "2. Yes, and don't ask again
// for this command (a)" / "Always allow" (Codex) — the last such option on screen wins.
export function findTrustOption(screen) {
  let hit = null;
  for (const line of String(screen || '').split('\n')) {
    const m = line.match(/(?:^|[\s›❯>│])(\d)[.)]\s+(.*\b(?:don'?t ask again|always|for this session|remember)\b.*|.*(?:不再询问|始终允许|总是允许).*)$/i);
    if (m) hit = { key: m[1], text: m[2].trim().slice(0, 120) };
  }
  return hit;
}

/**
 * null when the keys may go: still blocked on prompt `expect`, or (untagged) not working.
 * Untagged keys are refused only while the agent works — Esc would interrupt it — and still
 * go to terminals with no status (a startup dialog may be waiting for them).
 * A finished terminal refuses everything until it reports a status again.
 */
export function checkPrompt(t, expect) {
  const untagged = expect === undefined || expect === null || expect === '';
  if (Object.hasOwn(st.finished, t)) {
    return { ok: false, stale: true, expected: untagged ? null : expect, state: 'finished', prompt: null, error: 'terminal has finished' };
  }
  const state = st.last[t]?.state ?? null;
  if (untagged) {
    if (state !== 'working') return null;
    return { ok: false, stale: true, expected: null, state, prompt: null, error: 'agent is working; untagged keys refused' };
  }
  const want = Number(expect);
  const prompt = state === 'blocked' ? st.prompts[t]?.id ?? null : null;
  if (Number.isInteger(want) && prompt === want) return null;
  return { ok: false, stale: true, expected: expect, state, prompt, error: `prompt #${expect} is no longer on screen` };
}

async function staleReply(t, stale) {
  const r = await hc(['read', t, '--lines', '0'], { timeoutMs: 20000 });
  return { ...stale, screen: r.code ? '' : r.out.split('\n').slice(-14).join('\n') };
}

const TERM_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/;
function needT(t) { if (!t || !TERM_RE.test(String(t))) throw Object.assign(new Error('bad terminal address'), { status: 400 }); return String(t); }

async function opNew(b) {
  const machine = String(b.machine || '');
  const machines = cfg.machines || {};
  const m = machines[machine];
  if (!m) throw Object.assign(new Error(`unknown machine: ${machine} (have: ${Object.keys(machines).join(', ')})`), { status: 400 });
  const proj = b.project ? m.projects?.[b.project] : null;
  const cwd = b.cwd || proj?.path;
  if (!cwd) throw Object.assign(new Error(`unknown project: ${b.project} (have: ${Object.keys(m.projects || {}).join(', ')})`), { status: 400 });
  const template = String(b.template || m.defaultTemplate || 'worker');
  if (!/^[a-z0-9-]+$/.test(template)) throw Object.assign(new Error('bad template'), { status: 400 });
  const task = String(b.task || '').trim();
  if (!task) throw Object.assign(new Error('task is required'), { status: 400 });
  const name = `dd-${Date.now().toString(36).slice(-5)}`;
  const args = ['run', '--bg', '--name', name, '--cwd', cwd];
  if (machine !== cfg.self) args.push('--on', machine);
  if (proj?.space) args.push('--label', `herdr.space=${proj.space}`, '--label', `herdr.tab=tb${crypto.randomBytes(16).toString('hex')}`);
  // Codex templates carry no role text, so the rules go in front of the task.
  const text = template.endsWith('-codex') ? `${CODEX_RULES[template] || ''}\n\n${task}`.trim() : task;
  args.push(template, text);
  const r = await hc(args, { timeoutMs: 120000 });
  const res = parse(r.out);
  if (r.code || !res?.address) return { ok: false, step: 'run', out: r.out || r.err };
  const first = res.first_message || null;
  // "still starting" means it reported status but hc typed nothing; anything else
  // (never reported → maybe a dialog) is left for a person to read first.
  if (first?.sent === false && /still starting/.test(first.reason || '')) {
    await hc(['wait', res.address, '--timeout', '90'], { timeoutMs: 100000 });
    const s = await hc(['send', res.address, text]);
    const sent = parse(s.out);
    return { ok: true, address: res.address, name, cwd, template, sent: s.code ? { sent: false, reason: s.err || s.out } : { sent: true, ...sent, retried: true } };
  }
  return { ok: true, address: res.address, name, cwd, template, sent: first };
}

// ---------- Agent Hub tasks on the agent machines ----------
// Each machine keeps its own Hub database, worktrees and validation (qa/agent-hub/hub.py); the
// bridge only runs that hub.py through `hc exec --on`, with these subcommands and checked args.
const HUB_CMDS = new Set(['contexts', 'list', 'show', 'submit', 'followup', 'pause', 'resume', 'cancel', 'decide', 'advance', 'outbox', 'ack-notice']);
const CTX_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const DECISION_RE = /^d-[0-9a-f]{16}$/;
const SOURCE_RE = /^[A-Za-z0-9:_.-]{1,80}$/;
const MAX_HUB_SEEN = 2000;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export function hubMachines() {
  return Object.entries(cfg.machines || {}).filter(([, m]) => m?.hub?.python && m?.hub?.script).map(([n]) => n);
}

export function hubArgv(machine, args, timeoutS = 120) {
  const m = (cfg.machines || {})[machine];
  if (!m?.hub?.python || !m?.hub?.script) throw bad(`no Agent Hub on machine ${machine || '(none)'} (have: ${hubMachines().join(', ') || 'none'})`);
  if (!HUB_CMDS.has(args[0])) throw bad(`hub command not allowed: ${args[0]}`);
  const on = machine === cfg.self ? [] : ['--on', machine];
  return ['exec', ...on, '--json', '--timeout', String(Math.max(1, Math.min(timeoutS, 600))), '--', m.hub.python, m.hub.script, ...args.map(String)];
}

/** `hc exec --json` output → { ok, data } from the hub's JSON stdout, or { ok:false, error }. */
export function decodeExec(out) {
  const d = parse(out);
  if (!d) return { ok: false, error: 'unreadable hc exec output' };
  const text = (s) => Buffer.from(s || '', 'base64').toString('utf8');
  const stdout = text(d.stdout), stderr = text(d.stderr);
  const data = parse(stdout);
  if (d.code === 0 && data !== null) return { ok: true, data };
  const err = parse(stderr);
  return { ok: false, code: d.code ?? null, timed_out: !!d.timed_out, error: err?.message || (stderr || stdout).trim().slice(-400) || 'hub failed' };
}

async function hubCall(machine, args, timeoutS = 120) {
  const r = await hc(hubArgv(machine, args, timeoutS), { timeoutMs: (timeoutS + 60) * 1000 });
  if (r.code && !r.out) return { ok: false, error: (r.err || 'hc exec failed').trim().slice(-400) };
  return decodeExec(r.out);
}

/** A task id from a unique prefix (≥4 hex chars, with or without `t-`) among `list` rows. */
export function resolveTask(list, given) {
  const want = String(given || '').toLowerCase().replace(/^t-/, '');
  if (!/^[0-9a-f]{4,16}$/.test(want)) throw bad('task id: give at least 4 hex characters of t-…');
  const hits = (list || []).filter((t) => String(t.id).slice(2).startsWith(want));
  if (hits.length !== 1) throw bad(hits.length ? `task id ${given} is ambiguous: ${hits.slice(0, 5).map((t) => t.id).join(', ')}` : `no task ${given}`);
  return hits[0].id;
}

const eventId = () => `dd-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

/** What the plugin needs from a Hub `show`, without worktree paths' noise. */
export function summarizeTask(t) {
  const last = (t.validations || []).at(-1);
  const result = last ? parse(last.result) || {} : {};
  return {
    id: t.id, context: t.context_id, state: t.state, revision: t.revision, goal: String(t.goal || '').slice(0, 600),
    branch: t.branch, worktree: t.worktree, acceptance_current: !!t.acceptance_current,
    attempts: (t.attempts || []).map((a) => ({ number: a.number, address: a.address, state: a.state })),
    validation: last ? { id: last.id, revision: last.revision, passed: !!last.passed, checks: (result.checks || []).map((c) => ({ name: c.name, exit_code: c.exit_code })) } : null,
    decisions: (t.decisions || []).filter((d) => d.state === 'pending').map((d) => ({ id: d.id, question: d.question, choices: parse(d.choices) || [] })),
  };
}

/** A Hub outbox notice as the extra fields of a `task` change. */
export function noticeChange(machine, n) {
  const p = n.payload || {};
  const cut = (s, k) => (typeof s === 'string' ? s.slice(0, k) : null);
  return {
    machine, task: n.task_id, notice: n.kind, notice_id: n.id,
    summary: cut(p.summary, 600), outcome: p.outcome || null,
    failed: Array.isArray(p.failed_checks) ? p.failed_checks.map((c) => ({ name: c.name, exit_code: c.exit_code, log: c.log })) : null,
    checks: Array.isArray(p.checks) ? p.checks.map((c) => ({ name: c.name, exit_code: c.exit_code })) : null,
    decision: n.kind === 'decision' ? { id: p.id, question: cut(p.question, 300), choices: (p.choices || []).map((c) => cut(c, 200)) } : null,
    address: p.address || null, hint: cut(p.hint, 400),
  };
}

/** Record one notice as a change unless it was already recorded (an ack can fail after the push). */
export function recordNotice(machine, n) {
  const key = `${machine}:${n.id}`;
  if (st.hubSeen[key]) return false;
  noteChange(`${machine}/${n.task_id}`, 'task', noticeChange(machine, n));
  st.hubSeen[key] = Date.now();
  const keys = Object.keys(st.hubSeen);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_HUB_SEEN))) delete st.hubSeen[k];
  saveNow();
  return true;
}

let hubBusy = false;
async function hubTick() {
  if (hubBusy) return; // the previous round is still running
  hubBusy = true;
  try {
    for (const m of hubMachines()) {
      const adv = await hubCall(m, ['advance'], 300);
      if (!adv.ok) { log('hub advance', m, adv.error); continue; } // offline: try next round
      for (const s of adv.data || []) if (s.error) log('hub step', m, s.task_id, s.error);
      const ob = await hubCall(m, ['outbox']);
      if (!ob.ok) { log('hub outbox', m, ob.error); continue; }
      for (const n of ob.data || []) {
        recordNotice(m, n);
        const a = await hubCall(m, ['ack-notice', n.id]);
        if (!a.ok) log('hub ack failed', m, n.id, a.error);
      }
    }
  } catch (e) {
    log('hub tick error', String(e?.message || e));
  } finally {
    hubBusy = false;
  }
}

async function taskRoute(p, body) {
  const machine = String(body.machine || '');
  if (p === '/task/machines') return { ok: true, machines: hubMachines() };
  if (p === '/task/contexts') return hubCall(machine, ['contexts']);
  if (p === '/task/ls') {
    const out = [];
    for (const m of machine ? [machine] : hubMachines()) {
      const r = await hubCall(m, ['list']);
      out.push({ machine: m, ok: r.ok, error: r.error || null, tasks: r.ok ? r.data.slice(0, 20) : [] });
    }
    return { ok: true, machines: out };
  }
  const source = SOURCE_RE.test(String(body.source || '')) ? String(body.source) : 'dingtalk';
  const text = (v, name) => {
    const s = String(v ?? '').trim();
    if (!s || s.length > 4000) throw bad(`${name} must be 1..4000 characters`);
    return s;
  };
  const taskId = async () => {
    const l = await hubCall(machine, ['list']);
    if (!l.ok) throw bad(l.error, 502);
    return resolveTask(l.data, body.task);
  };
  const andStart = async (r) => {
    if (!r.ok) return r;
    const step = await hubCall(machine, ['advance'], 180); // start now, not at the next poll
    return { ok: true, task: r.data, advance: step.ok ? step.data : { error: step.error } };
  };
  if (p === '/task/new') {
    const ctx = String(body.context || '');
    if (!CTX_RE.test(ctx)) throw bad('bad context id');
    return andStart(await hubCall(machine, ['submit', ctx, '--goal', text(body.goal, 'goal'), '--source', source, '--event', eventId()]));
  }
  if (p === '/task/show') {
    const r = await hubCall(machine, ['show', await taskId()]);
    return r.ok ? { ok: true, task: summarizeTask(r.data) } : r;
  }
  if (p === '/task/followup') {
    const id = await taskId();
    return andStart(await hubCall(machine, ['followup', id, '--text', text(body.text, 'text'), '--source', source, '--event', eventId()]));
  }
  if (p === '/task/control') {
    const action = String(body.action || '');
    if (!['pause', 'resume', 'cancel'].includes(action)) throw bad('action must be pause, resume or cancel');
    return hubCall(machine, [action, await taskId()]);
  }
  if (p === '/task/decide') {
    const decision = String(body.decision || '');
    if (!DECISION_RE.test(decision)) throw bad('bad decision id');
    return hubCall(machine, ['decide', decision, '--choice', text(body.choice, 'choice'), '--source', source, '--event', eventId()]);
  }
  throw bad('not found', 404);
}

async function route(req, url, body) {
  const p = url.pathname;
  if (p.startsWith('/task/')) return taskRoute(p, body);
  if (p === '/health') { const m = await hc(['machine', 'ls']); return { ok: true, machines: parse(m.out)?.machines || m.err }; }
  if (p === '/ls') {
    const r = await hc(['ls']);
    const d = parse(r.out); if (!d) return { ok: false, out: r.out || r.err };
    const list = (d.terminals || []).map((t) => {
      const v = terms.get(t.address) || {};
      const status = v.status?.state || null;
      const prompt = status === 'blocked' ? st.prompts[t.address]?.id ?? null : null;
      return { t: t.address, name: t.name, agent: t.agent, cwd: t.cwd, where: whereOf(v) || null, status, prompt, app: v.status?.app || null, msg: v.status?.msg || null };
    });
    return { ok: true, machines: d.machines || [], terminals: list };
  }
  if (p === '/read') {
    // Screen only by default: with --lines, hc scrolls a full-screen app (Claude/Codex TUI) to stitch
    // its history, which takes ~20 s and moves the agent's view. History only when asked for.
    const hist = body.history ? Math.min(Math.max(+body.lines || 60, 1), 200) : 0;
    const r = await hc(['read', needT(body.t), '--lines', String(hist)], { timeoutMs: hist ? 60000 : 20000 });
    return { ok: !r.code, text: r.out || r.err };
  }
  if (p === '/send') { const r = await hc(['send', needT(body.t), String(body.text || '')]); return { ok: !r.code, out: parse(r.out) || r.out || r.err }; }
  if (p === '/keys') {
    const keys = (Array.isArray(body.keys) ? body.keys : [body.keys]).map(String).filter((k) => /^[A-Za-z0-9+_-]{1,20}$/.test(k));
    if (!keys.length) throw Object.assign(new Error('no keys'), { status: 400 });
    const t = needT(body.t);
    const stale = checkPrompt(t, body.expect);
    if (stale) return staleReply(t, stale);
    const r = await hc(['keys', t, ...keys]); return { ok: !r.code, out: r.out || r.err };
  }
  if (p === '/interrupt') { const r = await hc(['interrupt', needT(body.t)]); return { ok: !r.code, out: parse(r.out) || r.out || r.err }; }
  if (p === '/trust') {
    // Press the bottom-most "don't ask again / always" option of the permission prompt on screen.
    const t = needT(body.t);
    const stale = checkPrompt(t, body.expect);
    if (stale) return staleReply(t, stale);
    const r = await hc(['read', t, '--lines', '0'], { timeoutMs: 20000 });
    if (r.code) return { ok: false, error: r.err || r.out };
    const hit = findTrustOption(r.out);
    if (!hit) return { ok: false, error: 'no "don\'t ask again / always" option on screen', screen: r.out.split('\n').slice(-12).join('\n') };
    const k = await hc(['keys', t, hit.key]);
    return { ok: !k.code, key: hit.key, option: hit.text, out: k.out || k.err };
  }
  if (p === '/kill') { const r = await hc(['kill', needT(body.t)]); return { ok: !r.code, out: r.out || r.err }; }
  if (p === '/new') return opNew(body);
  if (p === '/changes') {
    const after = +url.searchParams.get('after') || 0;
    return { ok: true, last: st.nextId - 1, changes: st.changes.filter((c) => c.id > after).slice(0, 50) };
  }
  if (p === '/digest') {
    const day = st.day && st.day.date === today() ? st.day : { date: today(), agents: {} };
    const now = Date.now();
    const rows = Object.entries(day.agents).map(([t, a]) => {
      const live = st.last[t]?.state === 'working' ? now - (st.last[t].since || now) : 0;
      return { t, app: a.app, where: a.where, workingMin: Math.round((a.workingMs + live) / 60000), blocks: a.blocks, turns: a.turns };
    }).sort((x, y) => y.workingMin - x.workingMin);
    return { ok: true, date: day.date, agents: rows };
  }
  throw Object.assign(new Error('not found'), { status: 404 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const okAuth = auth.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(TOKEN));
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  if (!okAuth) return send(401, { ok: false, error: 'unauthorized' });
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1 << 20) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = raw ? JSON.parse(raw) : {};
      const out = await route(req, url, body);
      if (req.method !== 'GET') log(req.method, url.pathname, JSON.stringify(body).slice(0, 200), '->', out.ok);
      else if (process.env.HERDR_BRIDGE_DEBUG) log('GET', url.pathname + url.search);
      send(200, out);
    } catch (e) { send(e.status || 500, { ok: false, error: String(e.message || e) }); }
  });
});

// started as a service (not when a test imports it for applyStatus / checkPrompt)
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  startEvents();
  server.listen(PORT, '127.0.0.1', () => log(`herdr-bridge on 127.0.0.1:${PORT}, hc=${HC}, self=${cfg.self}, hubs=${hubMachines().join(',') || 'none'}`));
  if (hubMachines().length) {
    setTimeout(hubTick, 5000);
    setInterval(hubTick, Math.max(10, cfg.hubPollSeconds || 30) * 1000);
  }
}
