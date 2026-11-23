import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { askRepo, answerRepo, dismissRepo, listRepo, pendingCount, expireStale, waitForAnswer, isRefusal, inboxDir } from '../src/inbox.mjs';
import { startServer } from '../src/server.mjs';

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-inbox-'));
}

test('a question is written to disk and listed as open', () => {
  const repo = tmpRepo();
  const item = askRepo(repo, { title: 'Delete the old branch?', options: ['allow', 'skip'], askedBy: 'cli', node: 'cleanup' });
  assert.ok(fs.existsSync(path.join(inboxDir(repo), `${item.id}.json`)));
  const open = listRepo(repo, { status: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].title, 'Delete the old branch?');
  assert.deepEqual(open[0].options, ['allow', 'skip']);
  assert.equal(pendingCount(repo), 1);
});

test('an answer is recorded and the decisions log keeps the audit line', () => {
  const repo = tmpRepo();
  const item = askRepo(repo, { title: 'Ship it?', options: ['allow', 'skip'] });
  const answered = answerRepo(repo, item.id, { choice: 'allow', note: 'go ahead', by: 'you' });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer.choice, 'allow');
  assert.equal(pendingCount(repo), 0);
  const log = fs.readFileSync(path.join(inboxDir(repo), 'decisions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).choice, 'allow');
});

test('a second answer does not overwrite the first', () => {
  const repo = tmpRepo();
  const item = askRepo(repo, { title: 'Which model?', options: ['a', 'b'] });
  answerRepo(repo, item.id, { choice: 'a' });
  const again = answerRepo(repo, item.id, { choice: 'b' });
  assert.equal(again.answer.choice, 'a');
});

test('notes can be dismissed and count as read', () => {
  const repo = tmpRepo();
  const note = askRepo(repo, { kind: 'note', title: 'node build failed: exit 1', detail: 'run x' });
  assert.equal(pendingCount(repo), 0);
  const read = dismissRepo(repo, note.id);
  assert.equal(read.status, 'dismissed');
});

test('an unanswered question expires', () => {
  const repo = tmpRepo();
  const item = askRepo(repo, { title: 'Still there?', timeoutMs: 1 });
  const expired = expireStale(repo, Date.now() + 1000);
  assert.equal(expired.length, 1);
  assert.equal(listRepo(repo, { status: 'open' }).length, 0);
  assert.equal(listRepo(repo, { status: 'expired' })[0].id, item.id);
});

test('waitForAnswer returns the answer written from elsewhere', async () => {
  const repo = tmpRepo();
  const item = askRepo(repo, { title: 'Proceed?', options: ['allow', 'skip'] });
  setTimeout(() => answerRepo(repo, item.id, { choice: 'skip' }), 20);
  const waited = await waitForAnswer(repo, item.id, { timeoutMs: 2000, pollMs: 10 });
  assert.equal(waited.status, 'answered');
  assert.equal(waited.answer.choice, 'skip');
});

test('bad ids cannot escape the inbox folder', () => {
  const repo = tmpRepo();
  assert.equal(answerRepo(repo, '../../etc/passwd', { choice: 'x' }), null);
  assert.throws(() => askRepo(repo, { title: '' }));
});

test('refusals are recognised', () => {
  assert.equal(isRefusal('skip'), true);
  assert.equal(isRefusal('Deny'), true);
  assert.equal(isRefusal('allow'), false);
  assert.equal(isRefusal('yes, ship it'), false);
});

test('the server lists and answers inbox items', async () => {
  const repo = tmpRepo();
  const item = askRepo(repo, { title: 'Run the migration?', options: ['allow', 'skip'] });
  const srv = await startServer({ repoRoot: repo, port: 0, open: false, log: () => {} });
  try {
    const listed = await (await fetch(srv.url + '/api/inbox')).json();
    assert.equal(listed.count, 1);
    assert.equal(listed.open[0].id, item.id);

    const res = await fetch(srv.url + '/api/inbox/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, choice: 'allow' }),
    });
    const body = await res.json();
    assert.equal(body.item.status, 'answered');
    assert.equal(body.count, 0);

    const missing = await fetch(srv.url + '/api/inbox/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope-0000', choice: 'allow' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await srv.close();
  }
});

test('a node with "ask" holds the run until a person answers, and skip means skip', async () => {
  const { normalizeGraph } = await import('../src/graph.mjs');
  const { Guard } = await import('../src/guard.mjs');
  const { createRun, loadState } = await import('../src/state.mjs');
  const { Runner } = await import('../src/runner.mjs');
  const repo = tmpRepo();
  const graph = normalizeGraph({
    goal: 'gated',
    nodes: [
      { id: 'first', kind: 'shell', command: 'echo one >> trace.txt' },
      { id: 'second', kind: 'shell', command: 'echo two >> trace.txt', deps: ['first'], ask: 'Run the second step?', askOptions: ['allow', 'skip'] },
    ],
  });
  const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: repo, runDir: dir, state, graph, guard: new Guard({ minFreeBytes: 0, maxLoad: 1e9 }), opts: { pollMs: 20 }, log: () => {} });
  const running = runner.run();

  // Wait for the question to appear, then answer it from "the dashboard".
  let item = null;
  for (let i = 0; i < 200 && !item; i++) {
    item = listRepo(repo, { status: 'open' }).find((x) => x.kind === 'question') ?? null;
    if (!item) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(item, 'the inbox should hold a question while the node waits');
  assert.equal(item.title, 'Run the second step?');
  answerRepo(repo, item.id, { choice: 'skip', by: 'test' });

  const result = await running;
  assert.equal(result.complete, true);
  const after = loadState(dir);
  assert.equal(after.nodes.second.status, 'done');
  const trace = fs.readFileSync(path.join(repo, 'trace.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(trace, ['one'], 'a skipped node must not run its command');
});

test('a permanently failed node leaves a note in the inbox', async () => {
  const { normalizeGraph } = await import('../src/graph.mjs');
  const { Guard } = await import('../src/guard.mjs');
  const { createRun } = await import('../src/state.mjs');
  const { Runner } = await import('../src/runner.mjs');
  const repo = tmpRepo();
  const graph = normalizeGraph({ goal: 'breaks', nodes: [{ id: 'broken', kind: 'shell', command: 'exit 3', maxRetries: 0 }] });
  const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: repo, runDir: dir, state, graph, guard: new Guard({ minFreeBytes: 0, maxLoad: 1e9 }), opts: { pollMs: 20 }, log: () => {} });
  await runner.run();
  const notes = listRepo(repo).filter((i) => i.kind === 'note');
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /broken failed: exit 3/);
});
