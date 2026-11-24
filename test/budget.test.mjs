import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { loadLimits, loadLedger, saveLedger, writeLimits, weekStart, Budget, describeBudget } from '../src/budget.mjs';
import { normalizeGraph } from '../src/graph.mjs';
import { Guard } from '../src/guard.mjs';
import { createRun, loadState } from '../src/state.mjs';
import { Runner } from '../src/runner.mjs';
import { listRepo } from '../src/inbox.mjs';

const loose = () => new Guard({ minFreeBytes: 0, maxLoad: 1e9 });

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-budget-'));
}

function runOnce(repo, nodes) {
  const graph = normalizeGraph({ goal: 'budget', nodes });
  const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: repo, runDir: dir, state, graph, guard: loose(), opts: { pollMs: 20, stallMs: 60000 }, log: () => {} });
  return { dir, runner, graph };
}

test('the week starts on Monday, local midnight', () => {
  const week = weekStart(new Date(2026, 10, 26, 17, 30).getTime()); // a Thursday
  assert.equal(week, '2026-11-23');
});

test('limits come from the file, and a graph may tighten but never loosen them', () => {
  const repo = tmpRepo();
  writeLimits(repo, { nodes: 10, minutes: 60, money: 4 });
  assert.deepEqual(loadLimits(repo), { nodes: 10, minutes: 60, money: 4 });
  assert.deepEqual(loadLimits(repo, { budget: { nodes: 3 } }), { nodes: 3, minutes: 60, money: 4 });
  assert.deepEqual(loadLimits(repo, { budget: { nodes: 500 } }), { nodes: 10, minutes: 60, money: 4 });
});

test('the ledger resets on a new week and survives a reload', () => {
  const repo = tmpRepo();
  const budget = new Budget(repo).load();
  budget.spend({ minutes: 2.5, money: 1.25 });
  assert.equal(loadLedger(repo).nodes, 1);
  assert.equal(loadLedger(repo).minutes, 2.5);
  const nextWeek = new Date(2026, 11, 7, 9).getTime();
  const fresh = loadLedger(repo, nextWeek);
  assert.equal(fresh.nodes, 0);
  assert.equal(fresh.weekStart, '2026-12-07');
});

test('affordability projects the node being started', () => {
  const repo = tmpRepo();
  writeLimits(repo, { nodes: 2, money: 5 });
  const budget = new Budget(repo).load();
  assert.equal(budget.canAfford({ cost: 3 }).ok, true);
  budget.spend({ minutes: 1, money: 3 });
  assert.equal(budget.canAfford({ cost: 3 }).ok, false, 'money 3 + 3 > 5');
  budget.spend({ minutes: 1, money: 0 });
  assert.equal(budget.canAfford({}).ok, false, 'two nodes started, ceiling 2');
});

test('a run stops when the node ceiling is reached and leaves the rest pending', async () => {
  const repo = tmpRepo();
  writeLimits(repo, { nodes: 1 });
  const { dir, runner } = runOnce(repo, [
    { id: 'a', kind: 'shell', command: 'echo a >> trace.txt' },
    { id: 'b', kind: 'shell', command: 'echo b >> trace.txt', deps: ['a'] },
  ]);
  await runner.run();
  const after = loadState(dir);
  assert.equal(after.nodes.a.status, 'done');
  assert.equal(after.nodes.b.status, 'pending');
  assert.equal(loadLedger(repo).nodes, 1);
  assert.equal(fs.readFileSync(path.join(repo, 'trace.txt'), 'utf8').trim(), 'a');
  const notes = listRepo(repo).filter((i) => i.kind === 'note' && /ceiling/.test(i.title));
  assert.equal(notes.length, 1);
});

test('a money ceiling blocks a node that would overshoot', async () => {
  const repo = tmpRepo();
  writeLimits(repo, { money: 5 });
  const { dir, runner } = runOnce(repo, [
    { id: 'cheap', kind: 'shell', command: 'true', cost: 2 },
    { id: 'pricey', kind: 'shell', command: 'true', cost: 4, deps: ['cheap'] },
  ]);
  await runner.run();
  const after = loadState(dir);
  assert.equal(after.nodes.cheap.status, 'done');
  assert.equal(after.nodes.pricey.status, 'pending');
  assert.equal(loadLedger(repo).money, 2);
});

test('the summary line reads like a person wrote it', () => {
  const line = describeBudget({ nodes: 10, minutes: 60, money: 4 }, { nodes: 2, minutes: 12.5, money: 1 });
  assert.match(line, /nodes 2\/10/);
  assert.match(line, /minutes 12.5\/60/);
  assert.match(line, /left/);
  assert.equal(describeBudget({}, {}), 'no ceiling set');
});
