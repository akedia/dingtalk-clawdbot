#!/usr/bin/env node
// herdr-bridge: a narrow, token-guarded HTTP front for one machine's `hc`.
// The DingTalk plugin calls it; it never exposes `hc exec` or files.
//
//   GET  /health                      ok + machines
//   GET  /ls                          agents and terminals (live)
//   POST /read      {t, lines}        screen text
//   POST /send      {t, text}         paste + enter
//   POST /keys      {t, keys[]}       keys (enter, esc, 1, y, ctrl+c ...)
//   POST /interrupt {t}
//   POST /new       {machine, project|cwd, template?, task}
//   POST /kill      {t}
//   GET  /changes?after=N             status changes worth a push (durable ids)
//   GET  /digest                      today's working time / blocks / turns per agent
//
// Config: ~/.config/herdr-bridge/config.json   State: ~/.local/state/herdr-bridge/state.json
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';

const HOME = os.homedir();
const CONFIG_PATH = process.env.HERDR_BRIDGE_CONFIG || path.join(HOME, '.config/herdr-bridge/config.json');
const STATE_PATH = path.join(HOME, '.local/state/herdr-bridge/state.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const HC = cfg.hc || path.join(HOME, '.local/bin/hc');
const PORT = cfg.port || 8377;
const TOKEN = String(cfg.token || '');
if (TOKEN.length < 24) throw new Error('config.token must be at least 24 chars');
const NOTIFY_STATES = new Set(cfg.notifyStates || ['blocked', 'error', 'done', 'turn_end', 'exited']);
const MAX_CHANGES = 500;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- state (durable change ids + per-agent last state + daily digest) ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
const st = Object.assign({ nextId: 1, changes: [], last: {}, day: null }, loadState());
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, STATE_PATH);
  }, 300);
}
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

function applyStatus(addr, status, silent) {
  const prev = st.last[addr] || { state: null, since: Date.now() };
  const next = status?.state || null;
  if (prev.state === next) return;
  const now = Date.now();
  const b = dayBucket(addr);
  const r = terms.get(addr);
  b.app = appOf(r) || b.app; b.where = whereOf(r) || b.where;
  if (prev.state === 'working') b.workingMs += now - (prev.since || now);
  if (next === 'blocked') b.blocks++;
  st.last[addr] = { state: next, since: now };
  if (!silent) {
    if (next === 'blocked' && NOTIFY_STATES.has('blocked')) noteChange(addr, 'blocked', { msg: status?.msg || null });
    else if (next === 'error' && NOTIFY_STATES.has('error')) noteChange(addr, 'error', { msg: status?.msg || null });
    else if (next === 'done' && NOTIFY_STATES.has('done')) { b.turns++; noteChange(addr, 'done'); }
    else if (prev.state === 'working' && next === 'idle' && NOTIFY_STATES.has('turn_end')) { b.turns++; noteChange(addr, 'turn_end'); }
  }
  save();
}

function snapshot(list, silent = true) {
  terms.clear();
  for (const r of list || []) terms.set(r.address, r);
  for (const [a, r] of terms) if (r.status !== undefined) applyStatus(a, r.status, silent);
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
      case 'created': case 'restarted': terms.set(addr, { ...d, address: addr }); break;
      case 'removed': terms.delete(addr); break;
      case 'status': { const r = terms.get(addr) || { address: addr }; r.status = d.status; terms.set(addr, r); applyStatus(addr, d.status, false); break; }
      case 'labels': { const r = terms.get(addr); if (r) r.labels = d.labels; break; }
      case 'foreground': { const r = terms.get(addr); if (r) r.foreground = d; break; }
      case 'finished': {
        const r = terms.get(addr);
        const wasAgent = r && (r.reported || st.last[addr]?.state);
        if (r) { r.state = 'finished'; r.exit_code = d.exit_code; }
        if (wasAgent && NOTIFY_STATES.has('exited')) noteChange(addr, 'exited', { exit_code: d.exit_code, reason: d.reason });
        delete st.last[addr]; save();
        break;
      }
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
  const isCodex = template.endsWith('-codex');
  args.push(template);
  if (!isCodex) args.push(task);
  const r = await hc(args, { timeoutMs: 120000 });
  const res = parse(r.out);
  if (r.code || !res?.address) return { ok: false, step: 'run', out: r.out || r.err };
  if (isCodex) {
    await hc(['wait', res.address, '--timeout', '90'], { timeoutMs: 100000 });
    const s = await hc(['send', res.address, `${CODEX_RULES[template] || ''}\n\n${task}`.trim()]);
    return { ok: s.code === 0, address: res.address, name, cwd, template, sent: parse(s.out) || s.out || s.err };
  }
  return { ok: true, address: res.address, name, cwd, template, sent: res.first_message || null };
}

async function route(req, url, body) {
  const p = url.pathname;
  if (p === '/health') { const m = await hc(['machine', 'ls']); return { ok: true, machines: parse(m.out)?.machines || m.err }; }
  if (p === '/ls') {
    const r = await hc(['ls']);
    const d = parse(r.out); if (!d) return { ok: false, out: r.out || r.err };
    const list = (d.terminals || []).map((t) => {
      const v = terms.get(t.address) || {};
      return { t: t.address, name: t.name, agent: t.agent, cwd: t.cwd, where: whereOf(v) || null, status: v.status?.state || null, app: v.status?.app || null, msg: v.status?.msg || null };
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
    const r = await hc(['keys', needT(body.t), ...keys]); return { ok: !r.code, out: r.out || r.err };
  }
  if (p === '/interrupt') { const r = await hc(['interrupt', needT(body.t)]); return { ok: !r.code, out: parse(r.out) || r.out || r.err }; }
  if (p === '/trust') {
    // Press the bottom-most "don't ask again / always" option of the permission prompt on screen.
    const t = needT(body.t);
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

startEvents();
server.listen(PORT, '127.0.0.1', () => log(`herdr-bridge on 127.0.0.1:${PORT}, hc=${HC}, self=${cfg.self}`));
