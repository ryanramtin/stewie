import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeGraph } from '../src/graph.mjs';
import { Guard } from '../src/guard.mjs';
import { createRun } from '../src/state.mjs';
import { Runner } from '../src/runner.mjs';
import { undoNode, undoSummary } from '../src/undo.mjs';

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-undo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  // A name only: git accepts it for commits, and no address-shaped string lands in the repo.
  git('config', 'user.email', 'nobody');
  git('config', 'user.name', 'nobody');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.stewie/\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  return dir;
}

async function runNode(repo, command) {
  const graph = normalizeGraph({ goal: 'undo test', nodes: [{ id: 'edit', kind: 'shell', command }] });
  const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: repo, runDir: dir, state, graph, guard: new Guard({ minFreeBytes: 0, maxLoad: 1e9 }), opts: { pollMs: 20 }, log: () => {} });
  await runner.run();
  return state.runId;
}

test('undo restores an edited file and removes one the node created', async () => {
  const repo = gitRepo();
  const runId = await runNode(repo, "printf 'changed\\n' > a.txt && printf 'new\\n' > b.txt");
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'changed\n');
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));

  const result = undoNode(repo, { runId, node: 'edit' });
  assert.deepEqual(result.restored, ['a.txt']);
  assert.deepEqual(result.removed, ['b.txt']);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'original\n');
  assert.equal(fs.existsSync(path.join(repo, 'b.txt')), false);
  assert.match(undoSummary(result), /restored 1 file, removed 1 created file/);
});

test('a dry run reports the plan and changes nothing', async () => {
  const repo = gitRepo();
  const runId = await runNode(repo, "printf 'changed\\n' > a.txt");
  const result = undoNode(repo, { runId, node: 'edit', dryRun: true });
  assert.deepEqual(result.restored, ['a.txt']);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'changed\n');
});

test('undo leaves files the node never touched alone', async () => {
  const repo = gitRepo();
  const runId = await runNode(repo, "printf 'mine\\n' > a.txt");
  fs.writeFileSync(path.join(repo, 'later.txt'), 'someone else wrote this\n');
  undoNode(repo, { runId, node: 'edit' });
  assert.equal(fs.readFileSync(path.join(repo, 'later.txt'), 'utf8'), 'someone else wrote this\n');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'original\n');
});

test('an unknown node fails with a clear message', async () => {
  const repo = gitRepo();
  const runId = await runNode(repo, 'true');
  assert.throws(() => undoNode(repo, { runId, node: 'nope' }), /has no node/);
});
