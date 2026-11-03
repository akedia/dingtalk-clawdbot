import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-routing-'));
const bundle = process.env.HERDR_TEST_BUNDLE || path.join(scratch, 'herdr.mjs');
if (!process.env.HERDR_TEST_BUNDLE) {
  const { build } = await import('esbuild');
  await build({ entryPoints: [new URL('../src/herdr.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')], bundle: true, platform: 'node', format: 'esm', outfile: bundle });
}
const herdr = await import(pathToFileURL(bundle));
after(() => rm(scratch, { recursive: true, force: true }));

const account = { accountId: 'default', config: { herdr: { token: 'test-token-only', allowFrom: ['owner'], bridgeUrl: 'http://127.0.0.1:1' } } };

async function withBridge(run, answer = {}) {
  const calls = [];
  const replies = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ p, body });
    const data = answer[p] ? answer[p](body)
      : p === '/ls'
      ? { ok: true, machines: [], terminals: [{ t: 'dev/t4', status: 'blocked', app: 'codex' }] }
      : p === '/read' ? { ok: true, text: 'Would you like to run hostname?\n1. Yes\n2. Always\n3. No' }
      : { ok: true, option: 'Always', key: '2' };
    return { ok: true, json: async () => data };
  };
  const params = { account, senderId: 'owner', isDm: true, reply: async (text, opts) => replies.push({ text, opts }) };
  try { await run({ calls, replies, params }); } finally { globalThis.fetch = oldFetch; }
}

test('listing gives usable commands and never dispatches approvals', async () => withBridge(async ({ calls, replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd ls' });
  assert.deepEqual(calls.map(c => c.p), ['/ls']);
  const text = replies.map(r => r.text).join('\n');
  assert.match(text, /`\/hd read dev\/t4`/);
  assert.match(text, /`\/hd ok dev\/t4`/);
  assert.match(text, /`\/hd trust dev\/t4`/);
  assert.doesNotMatch(text, /dtmd:\/\/|\]\(/);
}));

test('read targets the requested terminal and unauthorized/group requests do nothing', async () => withBridge(async ({ calls, replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, senderId: 'outsider', text: '/hd ok dev/t4' });
  await herdr.handleHerdrCommand({ ...params, isDm: false, text: '/hd read dev/t4' });
  assert.equal(calls.length, 0);
  assert.equal(replies.length, 0);
  await herdr.handleHerdrCommand({ ...params, text: '/hd read dev/t4' });
  assert.deepEqual(calls.map(c => c.p), ['/read', '/ls']);
  assert.equal(calls[0].body.t, 'dev/t4');
  assert.match(replies[0].text, /hostname/);
}));

test('explicit approval and trust commands reach their distinct bridge operations', async () => withBridge(async ({ calls, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd ok dev/t4' });
  await herdr.handleHerdrCommand({ ...params, text: '/hd trust dev/t4' });
  assert.deepEqual(calls, [{ p: '/keys', body: { t: 'dev/t4', keys: ['enter'] } }, { p: '/trust', body: { t: 'dev/t4' } }]);
}));

test('reply sends the next message once, preserving newlines', async () => withBridge(async ({ calls, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd reply dev/t4' });
  assert.equal(await herdr.handleHerdrPendingReply({ ...params, text: 'line one\nline two' }), true);
  assert.equal(await herdr.handleHerdrPendingReply({ ...params, text: 'unrelated next message' }), false);
  assert.deepEqual(calls.filter(c => c.p === '/send'), [{ p: '/send', body: { t: 'dev/t4', text: 'line one\nline two' } }]);
}));

test('listed approvals carry the prompt id they answer', async () => withBridge(async ({ replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd ls' });
  const text = replies.map(r => r.text).join('\n');
  assert.match(text, /`\/hd ok dev\/t4 #42`/);
  assert.match(text, /`\/hd trust dev\/t4 #42`/);
  assert.match(text, /`\/hd no dev\/t4 #42`/);
}, { '/ls': () => ({ ok: true, machines: [], terminals: [{ t: 'dev/t4', status: 'blocked', prompt: 42, app: 'codex' }] }) }));

test('a prompt tag is passed as expect and is not mistaken for the key', async () => withBridge(async ({ calls, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd ok dev/t4 #42' });
  await herdr.handleHerdrCommand({ ...params, text: '/hd ok dev/t4 2 #42' });
  await herdr.handleHerdrCommand({ ...params, text: '/hd no dev/t4 #42' });
  await herdr.handleHerdrCommand({ ...params, text: '/hd trust dev/t4 #42' });
  assert.deepEqual(calls, [
    { p: '/keys', body: { t: 'dev/t4', keys: ['enter'], expect: 42 } },
    { p: '/keys', body: { t: 'dev/t4', keys: ['2'], expect: 42 } },
    { p: '/keys', body: { t: 'dev/t4', keys: ['esc'], expect: 42 } },
    { p: '/trust', body: { t: 'dev/t4', expect: 42 } },
  ]);
}));

test('a stale approval says nothing was pressed and offers the current prompt', async () => withBridge(async ({ replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd ok dev/t4 #42' });
  const text = replies.map(r => r.text).join('\n');
  assert.match(text, /#42 已过期，\*\*没有按键\*\*/);
  assert.match(text, /另一个问题 #43/);
  assert.match(text, /`\/hd ok dev\/t4 #43`/);
  assert.doesNotMatch(text, /已按/);
}, { '/keys': () => ({ ok: false, stale: true, expected: 42, state: 'blocked', prompt: 43, screen: 'Run rm -rf build?\n1. Yes\n2. No' }) }));

test('a stale approval on an agent that moved on offers no approval at all', async () => withBridge(async ({ replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd no dev/t4 #42' });
  const text = replies.map(r => r.text).join('\n');
  assert.match(text, /「工作中」/);
  assert.doesNotMatch(text, /\/hd (ok|no|trust) /);
  assert.match(text, /`\/hd int dev\/t4`/);
}, { '/keys': () => ({ ok: false, stale: true, expected: 42, state: 'working', prompt: null, screen: '' }) }));

test('an untagged choice refused because the agent works says so and offers interrupt', async () => withBridge(async ({ replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd no dev/t4' });
  const text = replies.map(r => r.text).join('\n');
  assert.match(text, /正在工作，\*\*没有按键\*\*/);
  assert.doesNotMatch(text, /#null|#undefined/);
  assert.match(text, /`\/hd int dev\/t4`/);
}, { '/keys': () => ({ ok: false, stale: true, expected: null, state: 'working', prompt: null, screen: '' }) }));

test('new reports a task that was not sent instead of claiming it started', async () => withBridge(async ({ replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd new dev x3analyze worker-codex 看一下' });
  const text = replies.map(r => r.text).join('\n');
  assert.match(text, /任务没发出去/);
  assert.match(text, /`\/hd read dev\/t9`/);
  assert.doesNotMatch(text, /🚀/);
}, { '/new': () => ({ ok: true, address: 'dev/t9', template: 'worker-codex', cwd: 'E:\x3analyze', sent: { sent: false, reason: 'it never reported its status' } }) }));

const finished = (expected) => () => ({ ok: false, stale: true, expected, state: 'finished', prompt: null, screen: 'E:\x3analyze>' });
const assertFinishedReply = (text) => {
  assert.match(text, /已结束/);
  assert.match(text, /\*\*没有按键\*\*/);
  assert.match(text, /`\/hd ls`/);
  assert.doesNotMatch(text, /状态未知|正在工作/);
  assert.doesNotMatch(text, /\/hd (read|reply|ok|no|trust|int|send)\b/);
};

test('a tagged choice on a finished terminal says it ended and offers only the list', async () => withBridge(async ({ replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd ok dev/t4 #42' });
  await herdr.handleHerdrCommand({ ...params, text: '/hd trust dev/t4 #42' });
  assert.equal(replies.length, 2);
  for (const r of replies) { assertFinishedReply(r.text); assert.match(r.text, /#42/); }
}, { '/keys': finished(42), '/trust': finished(42) }));

test('an untagged choice on a finished terminal is not reported as working', async () => withBridge(async ({ replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd no dev/t4' });
  const text = replies.map(r => r.text).join('\n');
  assertFinishedReply(text);
  assert.doesNotMatch(text, /#null|#undefined/);
}, { '/keys': finished(null) }));

test('a stale approval on an agent with no known state still says so', async () => withBridge(async ({ replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd ok dev/t4 #42' });
  const text = replies.map(r => r.text).join('\n');
  assert.match(text, /#42 已过期，\*\*没有按键\*\*（它现在状态未知）/);
  assert.match(text, /`\/hd read dev\/t4`/);
}, { '/keys': () => ({ ok: false, stale: true, expected: 42, state: null, prompt: null, screen: '' }) }));

test('task commands reach their bridge routes with the sender as source', async () => withBridge(async ({ calls, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd task new v172 dingtalk-plugin 修复 X\n第二行说明' });
  await herdr.handleHerdrCommand({ ...params, text: '/hd task show v172/ec29' });
  await herdr.handleHerdrCommand({ ...params, text: '/hd task fu v172/ec29 再补一个测试' });
  await herdr.handleHerdrCommand({ ...params, text: '/hd task pause v172/ec29' });
  await herdr.handleHerdrCommand({ ...params, text: '/hd task decide v172/d-0123456789abcdef 继续' });
  const by = (p) => calls.filter((c) => c.p === p).map((c) => c.body);
  assert.deepEqual(by('/task/new'), [{ machine: 'v172', context: 'dingtalk-plugin', goal: '修复 X\n第二行说明', source: 'dingtalk:owner' }]);
  assert.deepEqual(by('/task/show'), [{ machine: 'v172', task: 'ec29' }]);
  assert.deepEqual(by('/task/followup'), [{ machine: 'v172', task: 'ec29', text: '再补一个测试', source: 'dingtalk:owner' }]);
  assert.deepEqual(by('/task/control'), [{ machine: 'v172', task: 'ec29', action: 'pause' }]);
  assert.deepEqual(by('/task/decide'), [{ machine: 'v172', decision: 'd-0123456789abcdef', choice: '继续', source: 'dingtalk:owner' }]);
}, {
  '/task/new': () => ({ ok: true, task: { task_id: 't-ec29576533f54e29', duplicate: false }, advance: [{ task_id: 't-ec29576533f54e29', result: { state: 'working' } }] }),
  '/task/show': () => ({ ok: true, task: { id: 't-ec29576533f54e29', context: 'dingtalk-plugin', state: 'accepted', revision: 2, branch: 'agent-hub/t-ec29', goal: 'g', acceptance_current: true, attempts: [], validation: { revision: 2, passed: true, checks: [{ name: 'tests', exit_code: 0 }] }, decisions: [] } }),
  '/task/followup': () => ({ ok: true, task: { task_id: 't-ec29576533f54e29', revision: 3 } }),
  '/task/control': () => ({ ok: true, data: {} }),
  '/task/decide': () => ({ ok: true, data: {} }),
}));

test('task writes are deduplicated, reads are not, and outsiders get nothing', async () => withBridge(async ({ calls, replies, params }) => {
  for (const t of ['/hd task new v172 x y', '/hd task fu v172/ab12 z', '/hd task cancel v172/ab12', '/hd task decide v172/d-0123456789abcdef a'])
    assert.equal(herdr.isHerdrWriteCommand(t), true, t);
  for (const t of ['/hd task', '/hd task ls', '/hd task show v172/ab12']) assert.equal(herdr.isHerdrWriteCommand(t), false, t);
  await herdr.handleHerdrCommand({ ...params, senderId: 'outsider', text: '/hd task new v172 x y' });
  assert.equal(calls.length, 0);
  assert.equal(replies.length, 0);
}));

test('task list shows short ids, states and show commands', async () => withBridge(async ({ replies, params }) => {
  await herdr.handleHerdrCommand({ ...params, text: '/hd task ls' });
  const text = replies.map((r) => r.text).join('\n');
  assert.match(text, /`ec295765` dingtalk-plugin · 已通过/);
  assert.match(text, /`\/hd task show v172\/ec295765`/);
  assert.match(text, /\*\*dev\*\*：offline/);
}, { '/task/ls': () => ({ ok: true, machines: [
  { machine: 'v172', ok: true, tasks: [{ id: 't-ec29576533f54e29', context_id: 'dingtalk-plugin', state: 'accepted', goal: '修复' }] },
  { machine: 'dev', ok: false, error: 'offline', tasks: [] }] }) }));

test('task notices render what to do next', () => {
  const accepted = herdr.taskNoticeMd({ kind: 'task', notice: 'accepted', machine: 'v172', task: 't-ec29576533f54e29', checks: [{ name: 'tests', exit_code: 0 }] });
  assert.match(accepted, /独立验收通过/);
  assert.match(accepted, /tests ✓/);
  assert.match(accepted, /合入、部署仍需人工确认/);
  const failed = herdr.taskNoticeMd({ kind: 'task', notice: 'validation_failed', machine: 'v172', task: 't-ec29576533f54e29', failed: [{ name: 'tests', exit_code: 1, log: 'D:/x/0.log' }] });
  assert.match(failed, /tests 退出码 1/);
  assert.match(failed, /`\/hd task fu v172\/ec295765 <说明>`/);
  const decision = herdr.taskNoticeMd({ kind: 'task', notice: 'decision', machine: 'dev', task: 't-ab12ab12ab12ab12', decision: { id: 'd-0123456789abcdef', question: '继续吗？', choices: ['继续', 'reject'] } });
  assert.match(decision, /`\/hd task decide dev\/d-0123456789abcdef 继续`/);
  assert.match(decision, /`\/hd task decide dev\/d-0123456789abcdef reject`/);
  const waiting = herdr.taskNoticeMd({ kind: 'task', notice: 'executor_waiting', machine: 'v172', task: 't-ab12ab12ab12ab12', address: 't2t', hint: 'may show a dialog' });
  assert.match(waiting, /`\/hd read v172\/t2t`/);
  const report = herdr.taskNoticeMd({ kind: 'task', notice: 'awaiting_review', machine: 'v172', task: 't-ab12ab12ab12ab12', summary: '改好了\n第二行' });
  assert.match(report, /> 改好了/);
});
