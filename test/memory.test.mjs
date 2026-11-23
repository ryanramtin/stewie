import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  memoryDir,
  curatedPath,
  notesPath,
  ensureMemory,
  readCurated,
  curatedBody,
  addFact,
  rememberNode,
  readNotes,
  relevantNotes,
  memoryPrompt,
  memoryStats,
  parseNumstat,
  pruneNotes,
} from '../src/memory.mjs';
import { normalizeGraph } from '../src/graph.mjs';
import { Guard } from '../src/guard.mjs';
import { createRun } from '../src/state.mjs';
import { Runner } from '../src/runner.mjs';

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-memory-'));
}

const node = (id, task) => ({ id, kind: 'agent', task });
const done = () => ({ status: 'done', startedAt: Date.now() - 5000, endedAt: Date.now() });
const failed = (reason) => ({ status: 'failed', reason, startedAt: Date.now() - 5000, endedAt: Date.now() });

test('a fresh repo remembers nothing and says nothing', () => {
  const repo = tmpRepo();
  assert.equal(readNotes(repo).length, 0);
  assert.equal(curatedBody(repo), '');
  assert.equal(memoryPrompt(repo, { task: 'add a flag' }), '');
});

test('ensureMemory creates the folder and a MEMORY.md a person can edit', () => {
  const repo = tmpRepo();
  ensureMemory(repo);
  assert.ok(fs.existsSync(path.join(memoryDir(repo), 'MEMORY.md')));
  assert.match(readCurated(repo), /## Facts/);
  assert.match(readCurated(repo), /stewie memory add/);
});

test('memory add lands under the right heading, once', () => {
  const repo = tmpRepo();
  ensureMemory(repo);
  addFact(repo, 'the test command is pnpm test');
  addFact(repo, 'never touch the generated schema by hand', { section: 'Lessons' });
  const text = readCurated(repo);
  assert.match(text, /## Facts\n\n- the test command is pnpm test/);
  assert.match(text, /## Lessons\n\n- never touch/);
  const body = curatedBody(repo);
  assert.match(body, /pnpm test/);
  assert.doesNotMatch(body, /<!--/);
});

test('a remembered node keeps task, files, checks and summary', () => {
  const repo = tmpRepo();
  rememberNode(repo, {
    runId: '20261122-120000',
    node: node('api', 'add the challenge endpoint'),
    state: done(),
    result: { verify: [{ command: 'pnpm typecheck', code: 0 }] },
    files: [{ path: 'src/api.ts', add: 40, del: 3 }],
    summary: 'added POST /challenge',
  });
  const [note] = readNotes(repo);
  assert.equal(note.node, 'api');
  assert.equal(note.runId, '20261122-120000');
  assert.equal(note.status, 'done');
  assert.deepEqual(note.verify, [{ command: 'pnpm typecheck', ok: true }]);
  assert.equal(note.files[0].path, 'src/api.ts');
  assert.match(note.summary, /POST \/challenge/);
  assert.ok(fs.existsSync(notesPath(repo)));
});

test('secrets never reach the notes file', () => {
  const repo = tmpRepo();
  const key = `sk-${'a'.repeat(32)}`;
  rememberNode(repo, {
    runId: 'r1',
    node: node('leak', 'call the api'),
    state: done(),
    summary: `it worked with ${key}`,
  });
  const raw = fs.readFileSync(notesPath(repo), 'utf8');
  assert.doesNotMatch(raw, new RegExp(key));
  assert.match(raw, /redacted/);
});

test('the next prompt recalls the related node, not the unrelated one', () => {
  const repo = tmpRepo();
  const now = Date.now();
  rememberNode(repo, {
    runId: 'r1',
    node: node('api', 'add the challenge endpoint for passkey auth'),
    state: done(),
    summary: 'added POST /challenge, needed the session table',
    files: [{ path: 'src/api.ts', add: 10, del: 1 }],
    now: now - 3 * 86_400_000,
  });
  rememberNode(repo, {
    runId: 'r2',
    node: node('docs', 'rewrite the readme install section'),
    state: done(),
    summary: 'rewrote install',
    files: [{ path: 'README.md', add: 4, del: 2 }],
    now: now - 2 * 86_400_000,
  });

  const picked = relevantNotes(repo, { task: 'fix the passkey challenge endpoint', now });
  assert.equal(picked[0].node, 'api');

  const prompt = memoryPrompt(repo, { task: 'fix the passkey challenge endpoint', now });
  assert.match(prompt, /EARLIER NODES/);
  assert.match(prompt, /node api/);
  assert.match(prompt, /src\/api\.ts\(\+10\/-1\)/);
});

test('a failure is remembered as a failure, with its reason', () => {
  const repo = tmpRepo();
  const now = Date.now();
  rememberNode(repo, {
    runId: 'r1',
    node: node('check', 'run the schema check'),
    state: failed('verify failed: pnpm typecheck'),
    result: { verify: [{ command: 'pnpm typecheck', code: 2 }] },
    now,
  });
  const prompt = memoryPrompt(repo, { task: 'run the schema check', now });
  assert.match(prompt, /FAILED pnpm typecheck/);
  assert.match(prompt, /verify failed/);
});

test('curated memory is always in the prompt, even with no notes', () => {
  const repo = tmpRepo();
  ensureMemory(repo);
  addFact(repo, 'the real test command is pnpm test');
  const prompt = memoryPrompt(repo, { task: 'anything' });
  assert.match(prompt, /WRITTEN DOWN ABOUT THIS REPO/);
  assert.match(prompt, /pnpm test/);
  assert.doesNotMatch(prompt, /EARLIER NODES/);
});

test('the newest note for a node wins', () => {
  const repo = tmpRepo();
  const now = Date.now();
  rememberNode(repo, { runId: 'r1', node: node('api', 'add endpoint'), state: failed('broke it'), now: now - 86_400_000 });
  rememberNode(repo, { runId: 'r2', node: node('api', 'add endpoint'), state: done(), summary: 'fixed it', now });
  const prompt = memoryPrompt(repo, { task: 'add endpoint', now });
  assert.match(prompt, /fixed it/);
  assert.doesNotMatch(prompt, /broke it/);
});

test('the prompt stays inside its budget', () => {
  const repo = tmpRepo();
  ensureMemory(repo);
  addFact(repo, 'x'.repeat(4000));
  for (let i = 0; i < 12; i++) {
    rememberNode(repo, {
      runId: `r${i}`,
      node: node(`n${i}`, 'shared word shared word shared'),
      state: done(),
      summary: 'y'.repeat(900),
    });
  }
  const prompt = memoryPrompt(repo, { task: 'shared word' });
  assert.ok(prompt.length <= 2000, `prompt was ${prompt.length} chars`);
});

test('numstat parsing skips stewie state and keeps real files', () => {
  const files = parseNumstat('40\t3\tsrc/api.ts\n\n7\t0\tsrc/new.ts\n11\t2\t.stewie/runs/x/state.json\n');
  assert.deepEqual(files, [
    { path: 'src/api.ts', add: 40, del: 3 },
    { path: 'src/new.ts', add: 7, del: 0 },
  ]);
});

test('prune keeps the newest notes', () => {
  const repo = tmpRepo();
  for (let i = 0; i < 10; i++) {
    rememberNode(repo, { runId: `r${i}`, node: node(`n${i}`, `task ${i}`), state: done(), now: Date.now() + i });
  }
  assert.equal(pruneNotes(repo, { keep: 4 }), 6);
  const kept = readNotes(repo).map((n) => n.node);
  assert.deepEqual(kept, ['n6', 'n7', 'n8', 'n9']);
  assert.equal(pruneNotes(repo, { keep: 4 }), 0);
});

test('stats describe what is on disk', () => {
  const repo = tmpRepo();
  rememberNode(repo, { runId: 'r1', node: node('a', 'one'), state: done(), files: [{ path: 'src/a.ts', add: 1, del: 0 }] });
  rememberNode(repo, { runId: 'r1', node: node('b', 'two'), state: failed('nope') });
  const stats = memoryStats(repo);
  assert.equal(stats.notes, 2);
  assert.equal(stats.nodes, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.files, 1);
  assert.ok(stats.last);
});

test('a corrupt line does not lose the file', () => {
  const repo = tmpRepo();
  ensureMemory(repo);
  rememberNode(repo, { runId: 'r1', node: node('a', 'one'), state: done() });
  fs.appendFileSync(notesPath(repo), '{"half a li');
  const notes = readNotes(repo);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].node, 'a');
});

// ---------------------------------------------------------------- wiring

test('an agent node prompt carries the memory, and a node can opt out', () => {
  const repo = tmpRepo();
  ensureMemory(repo);
  addFact(repo, 'the real check is pnpm test');
  const graph = normalizeGraph({
    goal: 'ship it',
    nodes: [
      { id: 'a', task: 'do the thing' },
      { id: 'b', task: 'a clean-room attempt', memory: false },
    ],
  });
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-run-'));
  const runner = new Runner({ repoRoot: repo, runDir, state: { nodes: {} }, graph, guard: new Guard({}), opts: {} });

  assert.match(runner.promptFor(graph.nodes[0]), /MEMORY FROM EARLIER RUNS/);
  assert.match(runner.promptFor(graph.nodes[0]), /pnpm test/);
  assert.doesNotMatch(runner.promptFor(graph.nodes[1]), /pnpm test/);

  const off = normalizeGraph({ goal: 'ship it', memory: false, nodes: [{ id: 'a', task: 'do it' }] });
  const offRunner = new Runner({ repoRoot: repo, runDir, state: { nodes: {} }, graph: off, guard: new Guard({}), opts: {} });
  assert.doesNotMatch(offRunner.promptFor(off.nodes[0]), /pnpm test/);
});

test('a finished node is written down, and the next prompt reads it back', async () => {
  const repo = tmpRepo();
  const graph = normalizeGraph({ goal: 'test', concurrency: 1, nodes: [{ id: 's', command: 'echo hello > out.txt' }] });
  const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({
    repoRoot: repo,
    runDir: dir,
    state,
    graph,
    guard: new Guard({ minFreeBytes: 0, maxLoad: 1e9 }),
    opts: { pollMs: 40 },
    log: () => {},
  });

  const result = await runner.run();
  assert.equal(result.complete, true, JSON.stringify(result.counts));

  const notes = readNotes(repo);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].node, 's');
  assert.equal(notes[0].status, 'done');
  assert.equal(notes[0].runId, state.runId);

  assert.match(memoryPrompt(repo, { task: 'run the same command again' }), /node s/);
});
