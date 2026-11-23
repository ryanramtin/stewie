import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeGraph } from '../src/graph.mjs';
import { Guard } from '../src/guard.mjs';
import { createRun, loadState } from '../src/state.mjs';
import { Runner } from '../src/runner.mjs';
import { answerRepo, dismissRepo, listRepo, inboxDir } from '../src/inbox.mjs';

const loose = () => new Guard({ minFreeBytes: 0, maxLoad: 1e9 });
const FAST = { pollMs: 40, retryBaseMs: 80 };

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-run-'));
}

function mark(id, kind) {
  return `printf '%s ${id} %s\\n' ${kind} $(( $(date +%s%N) / 1000000 )) >> trace.txt`;
}

function graphOf(nodes) {
  return normalizeGraph({ goal: 'test', concurrency: 2, nodes });
}

test('runs a diamond DAG in dependency order with bounded parallelism', async () => {
  const root = tmpRepo();
  const graph = graphOf([
    { id: 'a', kind: 'shell', command: `sleep 0.4; ${mark('a', 'end')}` },
    { id: 'b', kind: 'shell', command: `sleep 0.4; ${mark('b', 'end')}` },
    { id: 'c', kind: 'shell', command: `sleep 0.2; ${mark('c', 'end')}`, deps: ['a', 'b'] },
    { id: 'd', kind: 'shell', command: `sleep 0.1; ${mark('d', 'end')}`, deps: ['c'] },
  ]);

  const { dir, state } = createRun(root, { graph, graphPath: 'g.json', concurrency: 2, model: null });
  const runner = new Runner({ repoRoot: root, runDir: dir, state, graph, guard: loose(), opts: FAST, log: () => {} });
  const result = await runner.run();

  assert.equal(result.complete, true, JSON.stringify(result.counts));
  const reloaded = loadState(dir);
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(reloaded.nodes[id].status, 'done', id);

  const trace = fs.readFileSync(path.join(root, 'trace.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '));
  const ends = Object.fromEntries(trace.map(([, id, ms]) => [id, Number(ms)]));
  assert.ok(ends.a <= ends.c + 50, 'c must start after a finishes');
  assert.ok(ends.b <= ends.c + 50, 'c must start after b finishes');
  assert.ok(ends.c <= ends.d, 'd must run after c');
});

test('never exceeds the concurrency ceiling', async () => {
  const root = tmpRepo();
  const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => ({
    id,
    kind: 'shell',
    command: `node -e "const fs=require('fs');fs.appendFileSync('trace.txt','start ${id}\\n');setTimeout(()=>fs.appendFileSync('trace.txt','end ${id}\\n'),250)"`,
  }));
  const graph = graphOf(nodes);
  const { dir, state } = createRun(root, { graph, graphPath: 'g.json', concurrency: 2, model: null });
  const runner = new Runner({ repoRoot: root, runDir: dir, state, graph, guard: loose(), opts: FAST, log: () => {} });
  await runner.run();

  let active = 0;
  let peak = 0;
  for (const line of fs.readFileSync(path.join(root, 'trace.txt'), 'utf8').trim().split('\n')) {
    active += line.startsWith('start') ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.equal(peak, 2);
});

test('retries a failing node then marks dependents blocked', async () => {
  const root = tmpRepo();
  const graph = graphOf([
    { id: 'bad', kind: 'shell', command: 'exit 7', maxRetries: 1 },
    { id: 'after', kind: 'shell', command: 'echo nope > should-not-exist.txt', deps: ['bad'] },
  ]);
  const { dir, state } = createRun(root, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: root, runDir: dir, state, graph, guard: loose(), opts: FAST, log: () => {} });
  const result = await runner.run();

  const st = loadState(dir);
  assert.equal(st.nodes.bad.status, 'failed');
  assert.equal(st.nodes.bad.attempts, 2);
  assert.equal(st.nodes.after.status, 'blocked');
  assert.equal(fs.existsSync(path.join(root, 'should-not-exist.txt')), false);
  assert.equal(result.complete, false);
});

test('verify command failure fails the node', async () => {
  const root = tmpRepo();
  const graph = graphOf([{ id: 'v', kind: 'shell', command: 'echo ok', verify: ['exit 3'], maxRetries: 0 }]);
  const { dir, state } = createRun(root, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: root, runDir: dir, state, graph, guard: loose(), opts: FAST, log: () => {} });
  await runner.run();

  const st = loadState(dir);
  assert.equal(st.nodes.v.status, 'failed');
  assert.match(st.nodes.v.reason, /verify failed/);
  assert.equal(st.nodes.v.verify[0].code, 3);
});

test('timeout kills the node and records it', async () => {
  const root = tmpRepo();
  const graph = graphOf([{ id: 'slow', kind: 'shell', command: 'sleep 30', timeoutMs: 600, maxRetries: 0 }]);
  const { dir, state } = createRun(root, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const started = Date.now();
  const runner = new Runner({ repoRoot: root, runDir: dir, state, graph, guard: loose(), opts: FAST, log: () => {} });
  await runner.run();
  const st = loadState(dir);
  assert.equal(st.nodes.slow.status, 'failed');
  assert.match(st.nodes.slow.reason, /timeout/);
  assert.ok(Date.now() - started < 15_000);
});

test('budget stops scheduling new work', async () => {
  const root = tmpRepo();
  const graph = graphOf([
    { id: 'one', kind: 'shell', command: 'sleep 0.1' },
    { id: 'two', kind: 'shell', command: 'sleep 0.1' },
  ]);
  const { dir, state } = createRun(root, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: root, runDir: dir, state, graph, guard: loose(), opts: { ...FAST, maxRuns: 1 }, log: () => {} });
  await runner.run();
  const st = loadState(dir);
  assert.equal(st.nodes.one.status, 'done');
  assert.equal(st.nodes.two.status, 'pending');
});

// ---------------------------------------------------------------- the inbox gate fails closed

async function waitForQuestion(repo, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const item = listRepo(repo, { status: 'open' }).find((i) => i.kind === 'question');
    if (item) return item;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

async function gatedRun(repo, answerWith) {
  const graph = graphOf([{ id: 'gated', kind: 'shell', command: 'echo ran >> trace.txt', ask: 'Run it?', askOptions: ['allow', 'hold', 'skip'] }]);
  const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: repo, runDir: dir, state, graph, guard: loose(), opts: FAST, log: () => {} });
  const running = runner.run();
  const item = await waitForQuestion(repo);
  assert.ok(item, 'a gated node should leave a question in the inbox');
  await answerWith(repo, item);
  const result = await running;
  const tracePath = path.join(repo, 'trace.txt');
  const trace = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { result, after: loadState(dir), trace };
}

test('gate: an explicit yes runs the node', async () => {
  const repo = tmpRepo();
  const { after, trace } = await gatedRun(repo, (root, item) => answerRepo(root, item.id, { choice: 'allow' }));
  assert.deepEqual(trace, ['ran']);
  assert.equal(after.nodes.gated.status, 'done');
});

test('gate: any other answer does not run the node', async () => {
  const repo = tmpRepo();
  const { after, trace } = await gatedRun(repo, (root, item) => answerRepo(root, item.id, { choice: 'hold' }));
  assert.deepEqual(trace, []);
  assert.equal(after.nodes.gated.status, 'done');
  assert.match(after.nodes.gated.reason, /skipped: hold/);
});

test('gate: a dismissed question does not run the node', async () => {
  const repo = tmpRepo();
  const { after, trace } = await gatedRun(repo, (root, item) => dismissRepo(root, item.id));
  assert.deepEqual(trace, []);
  assert.equal(after.nodes.gated.status, 'done');
  assert.match(after.nodes.gated.reason, /skipped/);
});

test('gate: a vanished question fails the node instead of running it', async () => {
  const repo = tmpRepo();
  const { after, trace } = await gatedRun(repo, (root, item) => {
    fs.unlinkSync(path.join(inboxDir(root), `${item.id}.json`));
  });
  assert.deepEqual(trace, []);
  assert.equal(after.nodes.gated.status, 'failed');
  assert.match(after.nodes.gated.reason, /gone/);
});
