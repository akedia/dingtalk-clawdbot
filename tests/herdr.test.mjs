import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-routing-'));
const bundle = path.join(scratch, 'herdr.mjs');
await build({ entryPoints: [new URL('../src/herdr.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')], bundle: true, platform: 'node', format: 'esm', outfile: bundle });
const herdr = await import(pathToFileURL(bundle));
after(() => rm(scratch, { recursive: true, force: true }));

const account = { accountId: 'default', config: { herdr: { token: 'test-token-only', allowFrom: ['owner'], bridgeUrl: 'http://127.0.0.1:1' } } };

async function withBridge(run) {
  const calls = [];
  const replies = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ p, body });
    const data = p === '/ls'
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
