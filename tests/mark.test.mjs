import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'mark-'));
after(() => rm(scratch, { recursive: true, force: true }));

// ---- plugin side (src/mark.ts), bundled like tests/herdr.test.mjs does
const bundle = path.join(scratch, 'mark.mjs');
const { build } = await import('esbuild');
await build({ entryPoints: [new URL('../src/mark.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')], bundle: true, platform: 'node', format: 'esm', outfile: bundle });
const mark = await import(pathToFileURL(bundle));

// ---- bridge side, with a Mark machine configured
process.env.HERDR_BRIDGE_CONFIG = path.join(scratch, 'config.json');
process.env.HERDR_BRIDGE_STATE = path.join(scratch, 'state.json');
await writeFile(process.env.HERDR_BRIDGE_CONFIG, JSON.stringify({
  token: 'x'.repeat(32), hc: 'hc-not-used', self: 'p2host',
  machines: { v172: { mark: { python: 'C:/py.exe', script: 'D:/x3analyze/qa/mark/mark.py', ssh: 'u@h', inbox: 'E:/x3-artifacts/marks/inbox' } } },
}));
const bridge = await import(new URL('../bridge/herdr-bridge.mjs', import.meta.url));

const account = { accountId: 'default', config: { herdr: { token: 'test-token-only', allowFrom: ['owner'], bridgeUrl: 'http://127.0.0.1:1' } } };

async function withBridge(run, answer = {}) {
  const calls = [];
  const replies = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ p, body });
    const data = answer[p] ? answer[p](body) : p === '/mark/new' ? { ok: true, machine: 'v172', mark: { short: 'ab12', id: '20261109-130000-ab12', state: 'received' } } : { ok: true, data: [] };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await run({ reply: async (text) => { replies.push(text); } });
  } finally {
    globalThis.fetch = oldFetch;
    mark._resetMarkDrafts();
  }
  return { calls, replies };
}

test('parseOpts pulls role/server/env out of the note', () => {
  assert.deepEqual(mark.parseOpts('派对卡组停卡 role=2105947 服:2370 env=beta'), { note: '派对卡组停卡', opts: { role: '2105947', server: '2370', env: 'beta' } });
});

test('splitPictures finds the rich-text picture placeholders', () => {
  assert.deepEqual(mark.splitPictures('看这里 [图片: /tmp/a.png] 还有 [图片: /tmp/b.jpg]'), { text: '看这里 还有', pictures: ['/tmp/a.png', '/tmp/b.jpg'] });
});

test('a draft collects a picture and voice, then "好了" submits them with the options', async () => {
  const pic = path.join(scratch, 'shot.png');
  await writeFile(pic, Buffer.from([1, 2, 3, 4]));
  const { calls, replies } = await withBridge(async ({ reply }) => {
    assert.equal(await mark.handleMarkCommand({ account, senderId: 'owner', isDm: true, text: '/mark 点感谢没反应 role=2105947 server=2370', reply }), true);
    assert.equal(await mark.handleMarkDraftMessage({ account, senderId: 'owner', isDm: true, text: '[picture] 媒体文件已下载: x', mediaPath: pic, messageType: 'picture', reply }), true);
    assert.equal(await mark.handleMarkDraftMessage({ account, senderId: 'owner', isDm: true, text: '在联盟聊天里点的', messageType: 'audio', reply }), true);
    assert.equal(await mark.handleMarkDraftMessage({ account, senderId: 'owner', isDm: true, text: '好了', reply }), true);
  });
  const sub = calls.find((c) => c.p === '/mark/new');
  assert.ok(sub, 'submitted');
  assert.equal(sub.body.note, '点感谢没反应');
  assert.equal(sub.body.voice_text, '在联盟聊天里点的');
  assert.equal(sub.body.role, '2105947');
  assert.equal(sub.body.server, '2370');
  assert.deepEqual(sub.body.files, [{ name: 'shot.png', b64: Buffer.from([1, 2, 3, 4]).toString('base64') }]);
  assert.match(replies.at(-1), /Mark #ab12/);
});

test('a /mark with an inline picture submits at once', async () => {
  const pic = path.join(scratch, 'inline.png');
  await writeFile(pic, 'x');
  const { calls } = await withBridge(async ({ reply }) => {
    await mark.handleMarkCommand({ account, senderId: 'owner', isDm: true, text: `/mark live 卡在加载 [图片: ${pic}]`, reply });
  });
  const sub = calls.find((c) => c.p === '/mark/new');
  assert.equal(sub.body.live, 'mumu');
  assert.equal(sub.body.note, '卡在加载');
  assert.equal(sub.body.files.length, 1);
});

test('others and groups never reach the bridge; no draft means not consumed', async () => {
  const { calls } = await withBridge(async ({ reply }) => {
    assert.equal(await mark.handleMarkCommand({ account, senderId: 'stranger', isDm: true, text: '/mark hi', reply }), true);
    assert.equal(await mark.handleMarkCommand({ account, senderId: 'owner', isDm: false, text: '/mark hi', reply }), true);
    assert.equal(await mark.handleMarkDraftMessage({ account, senderId: 'owner', isDm: true, text: 'hello', reply }), false);
  });
  assert.equal(calls.length, 0);
});

test('取消 drops an open draft without submitting', async () => {
  const { calls } = await withBridge(async ({ reply }) => {
    await mark.handleMarkCommand({ account, senderId: 'owner', isDm: true, text: '/mark 先开一单', reply });
    assert.equal(await mark.handleMarkDraftMessage({ account, senderId: 'owner', isDm: true, text: '取消', reply }), true);
    assert.equal(await mark.handleMarkDraftMessage({ account, senderId: 'owner', isDm: true, text: '好了', reply }), false);
  });
  assert.equal(calls.length, 0);
});

test('ls / show / ask / cancel go to their bridge routes', async () => {
  const { calls } = await withBridge(async ({ reply }) => {
    await mark.handleMarkCommand({ account, senderId: 'owner', isDm: true, text: '/mark ls', reply });
    await mark.handleMarkCommand({ account, senderId: 'owner', isDm: true, text: '/mark ab12', reply });
    await mark.handleMarkCommand({ account, senderId: 'owner', isDm: true, text: '/mark ask ab12 第19关兵力多少', reply });
    await mark.handleMarkCommand({ account, senderId: 'owner', isDm: true, text: '/mark cancel ab12', reply });
  }, { '/mark/show': () => ({ ok: true, data: { short: 'ab12', state: 'done', verdict: '非问题', summary: 's', report: '结论：非问题\n摘要：s\n## 现象\nx' } }) });
  assert.deepEqual(calls.map((c) => c.p), ['/mark/ls', '/mark/show', '/mark/ask', '/mark/cancel']);
  assert.deepEqual(calls[2].body, { id: 'ab12', text: '第19关兵力多少' });
});

test('a done push shows verdict and summary, and long reports come as a file', async () => {
  const long = '结论：已定位\n摘要：塔倒了血条还在\n' + '证据行\n'.repeat(1200);
  let n;
  await withBridge(async () => {
    n = await mark.markNotice({ token: 't', bridgeUrl: 'http://127.0.0.1:1' }, { kind: 'mark', machine: 'v172', mark: 'ab12', event: 'done', verdict: '已定位' });
  }, { '/mark/show': () => ({ ok: true, data: { short: 'ab12', state: 'done', verdict: '已定位', summary: '塔倒了血条还在', report: long } }) });
  assert.match(n.text, /Mark #ab12/);
  assert.match(n.text, /已定位/);
  assert.match(n.text, /引用本条回复 = 追问/);
  assert.ok(n.text.length <= 5000);
  assert.equal(n.file.name, 'mark-ab12-report.md');
});

test('bridge: mark argv only runs the configured mark.py with allowed commands', () => {
  assert.deepEqual(bridge.markArgv('v172', ['status', '--json', '--pending']),
    ['exec', '--on', 'v172', '--json', '--timeout', '120', '--', 'C:/py.exe', 'D:/x3analyze/qa/mark/mark.py', 'status', '--json', '--pending']);
  assert.throws(() => bridge.markArgv('v172', ['run', 'x']), /not allowed/);
  assert.throws(() => bridge.markArgv('dev', ['ls']), /no Mark/);
});

test('bridge: mark spec checks its fields and file names are made safe', () => {
  assert.deepEqual(bridge.markSpec({ note: ' 卡住 ', role: '123', env: 'beta', live: 'mumu', staff: 'owner', files: [] }),
    { note: '卡住', voice_text: '', role: '123', server: null, env: 'beta', live: 'mumu', serial: null, source: 'dingtalk', staff: 'owner' });
  assert.throws(() => bridge.markSpec({ note: 'x', env: 'gold' }), /env/);
  assert.throws(() => bridge.markSpec({ note: 'x', role: '12;rm' }), /digits/);
  assert.throws(() => bridge.markSpec({}), /needs a note/);
  assert.equal(bridge.safeName('../../etc/passwd', 1), 'passwd');
  assert.equal(bridge.safeName('.hidden', 2), 'file2');
  assert.equal(bridge.safeName('mark.json', 3), 'file3');
  assert.equal(bridge.safeName('截图 1.png', 4), '截图_1.png');
});

test('bridge: a mark event becomes one mark change, never twice', () => {
  const ev = { id: '20261109-130000-ab12', short: 'ab12', type: 'done', verdict: '已定位', summary: 's', note: 'n' };
  assert.equal(bridge.recordMarkEvent('v172', ev), true);
  assert.equal(bridge.recordMarkEvent('v172', ev), false);
  assert.equal(bridge.recordMarkEvent('v172', { ...ev, type: 'answer', followup: 1, q: 'q' }), true);
});
