import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeGraph } from '../src/graph.mjs';
import { createRun, saveState } from '../src/state.mjs';
import { askRepo } from '../src/inbox.mjs';
import { searchRepo } from '../src/search.mjs';

function repoWithRun() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-search-'));
  const graph = normalizeGraph({
    goal: 'Add passkey re-auth to settings',
    nodes: [
      { id: 'explore', task: 'Map the passkey code' },
      { id: 'implement', task: 'Wire the flow', verify: ['pnpm test'] },
    ],
  });
  const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  state.nodes.explore.status = 'done';
  state.nodes.implement.status = 'failed';
  state.nodes.implement.reason = 'verify failed: pnpm test';
  saveState(dir, state);
  fs.writeFileSync(path.join(dir, 'logs', 'implement.log'), 'reading src/auth/passkey.ts\nbaseline failing on purpose\n');
  return { repo, runId: state.runId };
}

test('a short query searches nothing', () => {
  const { repo } = repoWithRun();
  assert.deepEqual(searchRepo(repo, 'a').results, []);
});

test('a run is found by its goal and by its id', () => {
  const { repo, runId } = repoWithRun();
  const byGoal = searchRepo(repo, 'passkey').results;
  assert.ok(byGoal.some((r) => r.kind === 'run' && r.runId === runId));
  const byId = searchRepo(repo, runId).results;
  assert.ok(byId.some((r) => r.kind === 'run'));
});

test('nodes match on id and on failure reason', () => {
  const { repo } = repoWithRun();
  const results = searchRepo(repo, 'verify failed').results;
  assert.ok(results.some((r) => r.kind === 'node' && r.nodeId === 'implement'));
});

test('a log line is returned as its own readable hit', () => {
  const { repo } = repoWithRun();
  const results = searchRepo(repo, 'baseline').results;
  const log = results.find((r) => r.kind === 'log');
  assert.ok(log);
  assert.match(log.title, /baseline failing on purpose/);
  assert.equal(log.nodeId, 'implement');
});

test('inbox questions and answers are searchable', () => {
  const { repo } = repoWithRun();
  const item = askRepo(repo, { title: 'Ship the migration?', options: ['allow', 'skip'] });
  const found = searchRepo(repo, 'migration').results;
  assert.ok(found.some((r) => r.kind === 'inbox' && r.itemId === item.id));
});

test('the result list is capped', () => {
  const { repo } = repoWithRun();
  const results = searchRepo(repo, 'e', { limit: 2 }).results; // too short, empty
  assert.equal(results.length, 0);
  const many = searchRepo(repo, 'passkey', { limit: 1 }).results;
  assert.equal(many.length, 1);
});

test('search is case-insensitive and ignores surrounding space', () => {
  const { repo } = repoWithRun();
  assert.ok(searchRepo(repo, '  PASSKEY  ').results.length > 0);
});
