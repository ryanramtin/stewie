import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Guard, defaultConcurrency, systemSnapshot, describeSystem } from '../src/guard.mjs';
import { createRun, loadState, loadGraph, resolveRunDir, latestRun } from '../src/state.mjs';
import { normalizeGraph } from '../src/graph.mjs';

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-test-'));
}

test('defaultConcurrency is bounded', () => {
  assert.equal(defaultConcurrency(1), 1);
  assert.equal(defaultConcurrency(4), 1);
  assert.equal(defaultConcurrency(8), 2);
  assert.equal(defaultConcurrency(64), 3);
});

test('system snapshot reports sane values', () => {
  const s = systemSnapshot({ minFreeBytes: 0, maxLoad: 1e9 });
  assert.equal(s.ok, true);
  assert.ok(s.totalBytes > 0);
  assert.ok(s.ncpu >= 1);
  assert.match(describeSystem(s), /cores · load/);
});

test('guard holds when limits are impossible', () => {
  const g = new Guard({ minFreeBytes: Number.MAX_SAFE_INTEGER });
  const v = g.canStart();
  assert.equal(v.ok, false);
  assert.match(v.reason, /free RAM/);
});

test('run state round-trips and graph is frozen per run', () => {
  const root = tmpRepo();
  const graph = normalizeGraph({ goal: 'ship it', nodes: [{ id: 'a', task: 'x' }, { id: 'b', task: 'y', deps: ['a'] }] });
  const { runId, dir, state } = createRun(root, { graph, graphPath: 'g.json', concurrency: 2, model: null });

  assert.equal(state.nodes.a.status, 'pending');
  const loaded = loadState(dir);
  assert.equal(loaded.runId, runId);
  assert.equal(loadGraph(dir).nodes.length, 2);
  assert.equal(latestRun(root), runId);
  assert.equal(resolveRunDir(root, runId), dir);
  assert.equal(resolveRunDir(root, 'nope'), null);

  fs.appendFileSync(path.join(dir, 'state.json'), '');
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8').length > 0, true);
});
