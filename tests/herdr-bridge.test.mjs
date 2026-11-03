import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.equal(bridge.checkPrompt(t, undefined)?.stale, true, 'no tag on a working agent: refuse');
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

test('untagged keys are refused only while the agent works', () => {
  const t = 'dev/t3';
  assert.equal(bridge.checkPrompt(t, undefined), null, 'no status yet (startup dialog): allowed');
  bridge.applyStatus(t, { state: 'idle' }, true);
  assert.equal(bridge.checkPrompt(t, undefined), null);
  bridge.applyStatus(t, blocked('allow?'), true);
  assert.equal(bridge.checkPrompt(t, ''), null);
  bridge.applyStatus(t, { state: 'working' }, true);
  const r = bridge.checkPrompt(t, undefined);
  assert.deepEqual([r.stale, r.state, r.expected], [true, 'working', null]);
  bridge.applyStatus(t, { state: 'done' }, true);
  assert.equal(bridge.checkPrompt(t, null), null);
});

const savedState = async () => {
  await new Promise((r) => setTimeout(r, 400)); // save() is debounced by 300 ms
  return JSON.parse(await readFile(process.env.HERDR_BRIDGE_STATE, 'utf8'));
};

test('a finished terminal refuses keys as finished, tagged or not, until it reports again', async () => {
  const t = 'dev/t5';
  bridge.applyStatus(t, blocked('allow edit?'), false);
  const id = bridge.checkPrompt(t, -1).prompt;
  bridge.noteFinished(t, { exit_code: 0, reason: 'exited' });

  assert.deepEqual(bridge.checkPrompt(t, id), { ok: false, stale: true, state: 'finished', prompt: null, expected: id, error: 'terminal has finished' });
  for (const untagged of [undefined, null, '']) {
    const r = bridge.checkPrompt(t, untagged);
    assert.deepEqual([r?.stale, r?.state, r?.prompt, r?.expected], [true, 'finished', null, null]);
  }

  const s = await savedState();
  assert.ok(t in s.finished, 'finished mark is persisted');
  assert.equal(s.last[t], undefined);
  assert.equal(s.prompts[t], undefined);

  bridge.applyStatus(t, { state: 'idle' }, true);
  assert.equal(bridge.checkPrompt(t, undefined), null, 'a new status clears the finished mark');
  assert.ok(!((await savedState()).finished[t]));
});

test('a shell that never reported a status finishes without an exit push but is still marked', async () => {
  const t = 'dev/t6';
  const before = (await savedState()).changes.length;
  bridge.noteFinished(t, { exit_code: 1 });
  assert.equal(bridge.checkPrompt(t, undefined)?.state, 'finished');
  assert.equal((await savedState()).changes.length, before);
});

test('only the newest 500 finished marks are kept', async () => {
  for (let i = 0; i < 510; i++) bridge.noteFinished(`dev/cap${i}`, { exit_code: 0 });
  const keys = Object.keys((await savedState()).finished);
  assert.equal(keys.length, 500);
  assert.ok(!keys.includes('dev/cap0') && !keys.includes('dev/cap9'));
  assert.equal(keys.at(-1), 'dev/cap509');
  assert.equal(bridge.checkPrompt('dev/cap0', undefined), null, 'an evicted mark falls back to the normal rules');
  assert.equal(bridge.checkPrompt('dev/cap509', undefined)?.state, 'finished');
});

test('an address named like an Object.prototype key is not treated as finished', () => {
  assert.equal(bridge.checkPrompt('constructor', undefined), null);
});

test('a null status (what a finished terminal reports) keeps the finished mark', () => {
  const t = 'dev/t11';
  bridge.applyStatus(t, { state: 'working' }, true);
  bridge.noteFinished(t, { exit_code: 0 });
  bridge.applyStatus(t, null, true);
  bridge.applyStatus(t, undefined, true);
  bridge.applyStatus(t, {}, true);
  assert.equal(bridge.checkPrompt(t, undefined)?.state, 'finished');
  bridge.applyStatus(t, { state: 'working' }, true);
  assert.equal(bridge.checkPrompt(t, undefined)?.state, 'working', 'a real status clears it');
});

test('a reconnect snapshot keeps finished terminals finished without a new exit push', async () => {
  const gone = 'dev/t12', seenDead = 'dev/t13', live = 'dev/t14';
  bridge.applyStatus(gone, { state: 'working' }, true);       // finished while events were down
  bridge.noteFinished(seenDead, { exit_code: 0 });            // finished event already seen
  const before = (await savedState()).changes.length;
  bridge.snapshot([
    { address: gone, state: 'finished', exit_code: 0, status: null },
    { address: seenDead, state: 'finished', exit_code: 0, status: null },
    { address: live, state: 'running', status: { state: 'idle' } },
  ]);
  for (const t of [gone, seenDead]) assert.equal(bridge.checkPrompt(t, 7)?.state, 'finished');
  assert.equal(bridge.checkPrompt(live, undefined), null);
  const s = await savedState();
  assert.equal(s.changes.length, before, 'no exited (or any) change from a snapshot');
  assert.equal(s.last[gone], undefined);
  assert.ok(gone in s.finished && seenDead in s.finished);
});

test('a live agent that exits is still pushed as exited', async () => {
  const t = 'dev/t15';
  bridge.snapshot([{ address: t, state: 'running', status: { state: 'working' } }]);
  bridge.noteFinished(t, { exit_code: 3, reason: 'exited' });
  const ch = (await savedState()).changes.at(-1);
  assert.deepEqual([ch.kind, ch.t, ch.exit_code, ch.reason], ['exited', t, 3, 'exited']);
  assert.equal(bridge.checkPrompt(t, undefined)?.state, 'finished');
});
