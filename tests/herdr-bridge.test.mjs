import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Import the bridge as a module: it starts no server and touches no real state.
const dir = await mkdtemp(path.join(os.tmpdir(), 'herdr-bridge-'));
process.env.HERDR_BRIDGE_CONFIG = path.join(dir, 'config.json');
process.env.HERDR_BRIDGE_STATE = path.join(dir, 'state.json');
await writeFile(process.env.HERDR_BRIDGE_CONFIG, JSON.stringify({ token: 'x'.repeat(32), hc: 'hc-not-used' }));
const bridge = await import(new URL('../bridge/herdr-bridge.mjs', import.meta.url));
after(() => rm(dir, { recursive: true, force: true }));

const blocked = (msg, kind = 'permission') => ({ state: 'blocked', kind, msg });

test('each blocked episode gets its own prompt id and only that id passes', () => {
  const t = 'dev/t1';
  bridge.applyStatus(t, { state: 'working' }, false);
  assert.equal(bridge.checkPrompt(t, undefined), null, 'no tag: unchanged behaviour');
  assert.equal(bridge.checkPrompt(t, 1)?.stale, true, 'working agent: refuse');

  bridge.applyStatus(t, blocked('run hostname'), false);
  const first = bridge.checkPrompt(t, 999);
  assert.equal(first.state, 'blocked');
  const id1 = first.prompt;
  assert.equal(bridge.checkPrompt(t, id1), null);
  assert.equal(bridge.checkPrompt(t, String(id1)), null, 'id as sent in JSON from a string');

  bridge.applyStatus(t, blocked('run hostname'), false); // same question repeated
  assert.equal(bridge.checkPrompt(t, id1), null);

  bridge.applyStatus(t, blocked('rm -rf build'), false); // new question, never left blocked
  const second = bridge.checkPrompt(t, id1);
  assert.equal(second.stale, true);
  assert.ok(second.prompt > id1);

  bridge.applyStatus(t, { state: 'working' }, false);
  bridge.applyStatus(t, blocked('rm -rf build'), false); // same text, but a new episode
  const third = bridge.checkPrompt(t, second.prompt);
  assert.equal(third.stale, true);
  assert.ok(third.prompt > second.prompt);

  bridge.applyStatus(t, { state: 'idle' }, false);
  const gone = bridge.checkPrompt(t, third.prompt);
  assert.deepEqual([gone.stale, gone.state, gone.prompt], [true, 'idle', null]);
});

test('a silent snapshot still numbers a prompt so a tagged reply can match it', () => {
  const t = 'dev/t2';
  bridge.applyStatus(t, blocked('allow edit?'), true);
  const id = bridge.checkPrompt(t, -1).prompt;
  assert.ok(Number.isInteger(id));
  assert.equal(bridge.checkPrompt(t, id), null);
});
