import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runStartFromId, startOfWeek, startOfDay, addDays, calendarRuns, windowFor, runStatus } from '../src/calendar.mjs';
import { startServer } from '../src/server.mjs';

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-cal-'));
}

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const idFor = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Write a finished run the way the runner leaves it on disk. */
function writeRun(repo, startMs, { goal = 'demo', nodes = [], status = 'done' } = {}) {
  const id = idFor(startMs);
  const dir = path.join(repo, '.stewie', 'runs', id);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'diffs'), { recursive: true });
  const graph = {
    goal,
    nodes: nodes.map((n) => ({ id: n.id, kind: n.kind ?? 'agent', task: n.label ?? 'task', deps: [], verify: [] })),
  };
  const state = {
    version: 1,
    runId: id,
    goal,
    createdAt: new Date(startMs).toISOString(),
    updatedAt: new Date(startMs).toISOString(),
    stats: { runs: nodes.length, retries: 0, failures: 0, pauses: 0 },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, {
      status: n.status ?? status,
      attempts: 1,
      startedAt: n.startedAt ?? startMs,
      endedAt: n.endedAt ?? startMs + 60_000,
      exitCode: 0,
      verify: [],
      nextEligibleAt: 0,
      reason: n.reason ?? null,
    }])),
  };
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph, null, 2));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  if (nodes.some((n) => n.changed)) fs.writeFileSync(path.join(dir, 'diffs', `${nodes[0].id}.numstat`), '10\t2\tsrc/a.mjs\n');
  return id;
}

test('run ids parse back to their start time', () => {
  const ms = at(2025, 11, 20, 9, 15);
  const d = new Date(ms);
  const id = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-091500`;
  assert.equal(runStartFromId(id), at(2025, 11, 20, 9, 15));
  assert.equal(runStartFromId('not-a-run'), null);
});

test('a week starts on Monday, local midnight', () => {
  const sunday = at(2025, 11, 23, 17, 30);
  const monday = startOfWeek(sunday);
  assert.equal(new Date(monday).getDay(), 1);
  assert.equal(monday, startOfDay(monday));
  assert.equal(addDays(monday, 7) - monday, 7 * 86_400_000);
});

test('calendarRuns places runs in the window and summarises them', () => {
  const repo = tmpRepo();
  const monday = at(2025, 11, 17, 0);
  writeRun(repo, at(2025, 11, 17, 9), { goal: 'ship the flag', nodes: [
    { id: 'explore', startedAt: at(2025, 11, 17, 9), endedAt: at(2025, 11, 17, 9, 5) },
    { id: 'build', startedAt: at(2025, 11, 17, 9, 6), endedAt: at(2025, 11, 17, 9, 20), status: 'failed', reason: 'exit 1', changed: true },
  ] });
  writeRun(repo, at(2025, 10, 1, 9), { goal: 'old run' });

  const runs = calendarRuns(repo, { from: monday, to: addDays(monday, 7) });
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.goal, 'ship the flag');
  assert.equal(run.status, 'failed');
  assert.equal(run.nodes.length, 2);
  assert.equal(run.startedAt, at(2025, 11, 17, 9));
  assert.equal(run.endedAt, at(2025, 11, 17, 9, 20));
  assert.equal(run.changes.files, 1);
  assert.equal(run.changes.adds, 10);
  assert.equal(run.counts.failed, 1);
});

test('a run outside the window is not opened', () => {
  const repo = tmpRepo();
  writeRun(repo, at(2025, 11, 17, 9));
  const { from, to } = windowFor(at(2025, 11, 25, 12), 7);
  assert.deepEqual(calendarRuns(repo, { from, to }), []);
});

test('runStatus prefers the live worker', () => {
  assert.equal(runStatus({ a: { status: 'running' }, b: { status: 'failed' } }), 'running');
  assert.equal(runStatus({ a: { status: 'done' }, b: { status: 'failed' } }), 'failed');
  assert.equal(runStatus({ a: { status: 'done' }, b: { status: 'pending' } }), 'paused');
  assert.equal(runStatus({ a: { status: 'done' } }), 'done');
});

test('the server serves the week with totals', async () => {
  const repo = tmpRepo();
  const anchor = at(2025, 11, 19, 12);
  const id = writeRun(repo, at(2025, 11, 17, 9), { nodes: [{ id: 'a' }, { id: 'b', status: 'running', endedAt: null }] });
  const srv = await startServer({ repoRoot: repo, port: 0, open: false, log: () => {} });
  try {
    const data = await (await fetch(srv.url + '/api/calendar?anchor=' + anchor + '&days=7')).json();
    assert.equal(data.days, 7);
    assert.equal(data.runs.length, 1);
    assert.equal(data.runs[0].id, id);
    assert.equal(data.totals.runs, 1);
    assert.equal(data.totals.running, 1);
    assert.equal(new Date(data.from).getDay(), 1);
  } finally {
    await srv.close();
  }
});
