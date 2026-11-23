import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeGraph } from '../src/graph.mjs';
import { Guard } from '../src/guard.mjs';
import { createRun, loadState } from '../src/state.mjs';
import { Runner, notify } from '../src/runner.mjs';
import { answerRepo, listRepo } from '../src/inbox.mjs';

const loose = () => new Guard({ minFreeBytes: 0, maxLoad: 1e9 });
const stuck = () => new Guard({ minFreeBytes: 1e18, maxLoad: 0 });
const FAST = { pollMs: 20, retryBaseMs: 20 };

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-safety-'));
}

function runOnce(repo, nodes, opts = {}, guard = loose()) {
  const graph = normalizeGraph({ goal: 'safety', nodes });
  const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: repo, runDir: dir, state, graph, guard, opts: { ...FAST, ...opts }, log: () => {} });
  return { graph, dir, state, runner };
}

test('a busy machine holds the run instead of starting a node anyway', async () => {
  const repo = tmpRepo();
  const { dir, runner } = runOnce(repo, [{ id: 'a', kind: 'shell', command: 'echo ran >> trace.txt' }], { stallMs: 10 }, stuck());
  const running = runner.run();
  await new Promise((r) => setTimeout(r, 250));
  runner.stop('test');
  await running;
  assert.equal(loadState(dir).nodes.a.status, 'pending');
  assert.equal(fs.existsSync(path.join(repo, 'trace.txt')), false, 'no node may run while the machine is busy');
});

test('--force-start is the deliberate override', async () => {
  const repo = tmpRepo();
  const { dir, runner } = runOnce(repo, [{ id: 'a', kind: 'shell', command: 'echo ran >> trace.txt' }], { stallMs: 10, forceStart: true }, stuck());
  await runner.run();
  assert.equal(loadState(dir).nodes.a.status, 'done');
  assert.equal(fs.readFileSync(path.join(repo, 'trace.txt'), 'utf8').trim(), 'ran');
});

test('a waiting question pings a person, and so does a dead node', async () => {
  const repo = tmpRepo();
  const pings = [];
  const { runner } = runOnce(
    repo,
    [{ id: 'gated', kind: 'shell', command: 'echo ran >> trace.txt', ask: 'Run it?', askOptions: ['allow', 'skip'], maxRetries: 0 }],
    { notify: (title, message) => pings.push([title, message]) },
  );
  const running = runner.run();
  let item;
  for (let i = 0; i < 200 && !item; i++) {
    item = listRepo(repo, { status: 'open' }).find((x) => x.kind === 'question');
    if (!item) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(item, 'a question should be waiting');
  answerRepo(repo, item.id, { choice: 'skip' });
  await running;
  assert.equal(pings.length, 1);
  assert.match(pings[0][0], /waiting on you/);
});

test('a failed node pings too', async () => {
  const repo = tmpRepo();
  const pings = [];
  const { runner } = runOnce(repo, [{ id: 'a', kind: 'shell', command: 'exit 4', maxRetries: 0 }], {
    notify: (title, message) => pings.push([title, message]),
  });
  await runner.run();
  assert.equal(pings.length, 1);
  assert.match(pings[0][0], /a node failed/);
});

test('notifications can be turned off and stay quiet off macOS', () => {
  const previous = process.env.STEWIE_NO_NOTIFY;
  process.env.STEWIE_NO_NOTIFY = '1';
  try {
    assert.equal(notify('t', 'm'), false);
  } finally {
    if (previous === undefined) delete process.env.STEWIE_NO_NOTIFY;
    else process.env.STEWIE_NO_NOTIFY = previous;
  }
});
