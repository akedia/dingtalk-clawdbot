import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-push-'));
process.env.OPENCLAW_STATE_DIR = scratch; // push records go here, not to the real cache
const bundle = process.env.HERDR_TEST_BUNDLE || path.join(scratch, 'herdr.mjs');
if (!process.env.HERDR_TEST_BUNDLE) {
  const { build } = await import('esbuild');
  await build({ entryPoints: [new URL('../src/herdr.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')], bundle: true, platform: 'node', format: 'esm', outfile: bundle });
}
const herdr = await import(pathToFileURL(bundle));
after(() => rm(scratch, { recursive: true, force: true }));

const RULE = '─'.repeat(86);
// a Claude Code screen after a turn: earlier turn, prompt-suggestion in the input box, status bar
const CLAUDE_DONE = [
  '● 我先看一下状态。',
  '',
  '✻ Cooked for 12s · done 10:39',
  '',
  '❯ git sync 推上去',
  '',
  '● Bash(git sync)',
  '  ⎿  pushed 71ab548',
  '',
  '  Searched for 1 pattern, ran 1 shell command',
  '',
  '● 已经推上去了：GitLab 和 GitHub 私有库都更新到 71ab548，本机的 pub/t4f-pc-2010099',
  '  分支也有备份。',
  '',
  '  - 第一项',
  '  - 第二项很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长',
  '    的续行',
  '',
  '✻ Crunched for 14s · done 10:43',
  '                                              ✔ Update installed · Restart to update',
  RULE,
  '❯ 好，推完告诉我',
  RULE,
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
  '',
].join('\n');

const CLAUDE_BLOCKED = [
  '● Bash(rm -rf build)',
  RULE,
  ' Bash command',
  '   rm -rf build',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for rm commands",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
].join('\n');

const CODEX_DONE = [
  '› 修一下登录',
  '',
  '• Ran npm test',
  '  └ 12 passed',
  '',
  '• 登录修好了，测试全过。',
  '',
  '─ Worked for 1m 02s ──────────────────────────────────────────',
  '',
  '› Implement {feature}',
  '',
  '  100% context left · ? for shortcuts',
].join('\n');

test('a finished turn shows only the agent\'s words from that turn', () => {
  const s = herdr.turnSummary(CLAUDE_DONE);
  const text = s.lines.join('\n');
  assert.equal(s.ask, 'git sync 推上去');
  assert.match(text, /^已经推上去了：GitLab 和 GitHub 私有库都更新到 71ab548，本机的 pub\/t4f-pc-2010099分支也有备份。/);
  assert.match(text, /- 第二项很长.*的续行/);
  for (const noise of [/好，推完告诉我/, /auto mode/, /Update installed/, /─{5}/, /Crunched/, /pushed 71ab548/, /Searched for/, /我先看一下/]) {
    assert.doesNotMatch(text, noise);
  }
  assert.match(s.title, /^已经推上去了/);
});

test('codex screens lose the input placeholder, status and tool output', () => {
  const s = herdr.turnSummary(CODEX_DONE);
  assert.equal(s.ask, '修一下登录');
  assert.deepEqual(s.lines, ['登录修好了，测试全过。']);
});

test('a permission menu is kept while rules are dropped', () => {
  const lines = herdr.readable(CLAUDE_BLOCKED, 14);
  assert.ok(lines.some((l) => /❯ 1\. Yes/.test(l)));
  assert.ok(lines.some((l) => /3\. No/.test(l)));
  assert.ok(!lines.some((l) => /─{5}/.test(l)));
});

function withBridge(screen, rows = []) {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ p, body });
    const data = p === '/read' ? { ok: true, text: screen }
      : p === '/ls' ? { ok: true, machines: [], terminals: rows }
      : { ok: true };
    return { ok: true, json: async () => data };
  };
  return { calls, restore: () => { globalThis.fetch = oldFetch; } };
}

const account = { accountId: 'default', config: { herdr: { token: 'test-token-only', allowFrom: ['owner'], bridgeUrl: 'http://127.0.0.1:1' } } };
const h = account.config.herdr;

test('push notices are compact and say how to answer by quoting', async () => {
  const b = withBridge(CLAUDE_DONE);
  try {
    const n = await herdr.changeNotice(h, { kind: 'turn_end', t: 'v172/t3c', app: 'claude-code', where: 'x3analyze / 2' });
    assert.match(n.text, /本轮完成 · v172\/t3c/);
    assert.match(n.text, /你：git sync 推上去/);
    assert.match(n.text, /引用本条回复/);
    assert.doesNotMatch(n.text, /auto mode|好，推完告诉我|─{5}|\/hd reply/);
    assert.match(n.title, /^✅ t3c：已经推上去了/);
    assert.deepEqual(n.target, { t: 'v172/t3c', kind: 'turn_end', prompt: null });
    const blocked = await herdr.changeNotice(h, { kind: 'blocked', t: 'v172/t3c', prompt: 42 });
    assert.match(blocked.text, /引用本条回 1\*\* 批准/);
    assert.match(blocked.text, /`\/hd ok v172\/t3c #42`/);
    assert.equal(blocked.target.prompt, 42);
  } finally { b.restore(); }
});

async function quoteReply(text, quote, rows = []) {
  const b = withBridge('', rows);
  const replies = [];
  try {
    const routed = await herdr.handleHerdrQuoteReply({ account, senderId: 'owner', isDm: true, text, quote, reply: async (t) => replies.push(t) });
    return { routed, calls: b.calls, replies };
  } finally { b.restore(); }
}

test('quoting a push sends the reply to that agent, found by key, time or text', async () => {
  const now = Date.now();
  herdr.recordPush('default', { key: 'pqk-1', at: now - 60_000, t: 'v172/t3c', kind: 'turn_end', prompt: null });
  herdr.recordPush('default', { key: 'pqk-2', at: now, t: 'dev/t5', kind: 'blocked', prompt: 7 });

  let r = await quoteReply('好，推完告诉我', { key: 'pqk-1' });
  assert.equal(r.routed, true);
  assert.deepEqual(r.calls.find((c) => c.p === '/send').body, { t: 'v172/t3c', text: '好，推完告诉我' });

  r = await quoteReply('继续', { createdAt: now - 57_000 });
  assert.equal(r.calls.find((c) => c.p === '/send').body.t, 'v172/t3c');

  r = await quoteReply('继续', { text: '✅ 本轮完成 · dev/t9 …' });
  assert.equal(r.calls.find((c) => c.p === '/send').body.t, 'dev/t9');

  r = await quoteReply('[引用回复 (Jax): "x"]\n第二行也要', { key: 'pqk-1' });
  assert.equal(r.calls.find((c) => c.p === '/send').body.text, '第二行也要');
});

test('a quote on a blocked push answers its prompt and never types into the menu', async () => {
  let r = await quoteReply('1', { key: 'pqk-2' });
  assert.deepEqual(r.calls.find((c) => c.p === '/keys').body, { t: 'dev/t5', keys: ['enter'], expect: 7 });
  r = await quoteReply('始终', { key: 'pqk-2' });
  assert.deepEqual(r.calls.find((c) => c.p === '/trust').body, { t: 'dev/t5', expect: 7 });
  r = await quoteReply('拒绝', { key: 'pqk-2' });
  assert.deepEqual(r.calls.find((c) => c.p === '/keys').body, { t: 'dev/t5', keys: ['esc'], expect: 7 });
  r = await quoteReply('换个做法', { key: 'pqk-2' }, [{ t: 'dev/t5', status: 'blocked' }]);
  assert.equal(r.routed, true);
  assert.ok(!r.calls.some((c) => c.p === '/send' || c.p === '/keys'));
  assert.match(r.replies.join('\n'), /还在等你批准/);
  r = await quoteReply('换个做法', { key: 'pqk-2' }, [{ t: 'dev/t5', status: 'done' }]);
  assert.deepEqual(r.calls.find((c) => c.p === '/send').body, { t: 'dev/t5', text: '换个做法' });
});

test('quotes that are not ours, or from outsiders, are left alone', async () => {
  let r = await quoteReply('随便聊聊', { key: 'someone-else', text: '今天天气不错' });
  assert.equal(r.routed, false);
  assert.equal(r.calls.length, 0);
  // the AI's own reply sent right after a push, or one that merely names a terminal
  r = await quoteReply('嗯', { key: 'ai-reply', createdAt: Date.now() });
  assert.equal(r.routed, false);
  r = await quoteReply('嗯', { text: '你可以用 /hd read v172/t3c 看屏' });
  assert.equal(r.routed, false);
  const b = withBridge('');
  try {
    const routed = await herdr.handleHerdrQuoteReply({ account, senderId: 'outsider', isDm: true, text: 'hi', quote: { key: 'pqk-1' }, reply: async () => {} });
    assert.equal(routed, false);
    assert.equal(b.calls.length, 0);
  } finally { b.restore(); }
});

test('quote shapes from DingTalk are read', () => {
  assert.deepEqual(herdr.herdrQuoteOf({ originalProcessQueryKey: 'k', text: { isReplyMsg: true, repliedMsg: { msgId: 'm', createdAt: 5, content: { text: 'x' } } } }),
    { key: 'k', msgId: 'm', createdAt: 5, text: 'x' });
  assert.equal(herdr.herdrQuoteOf({ text: { content: 'plain' } }), null);
});
