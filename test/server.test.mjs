import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeGraph } from '../src/graph.mjs';
import { createRun, saveState } from '../src/state.mjs';
import { startServer } from '../src/server.mjs';

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-srv-'));
}

async function withServer(fn) {
  const repo = tmpRepo();
  const srv = await startServer({ repoRoot: repo, port: 0, open: false, log: () => {} });
  try {
    await fn(repo, srv);
  } finally {
    await srv.close();
  }
}

test('serves the dashboard page', async () => {
  await withServer(async (_repo, srv) => {
    const res = await fetch(srv.url + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>stewie console<\/title>/);
    assert.match(html, /Changed/);
    assert.match(html, /api\/overview/);
  });
});

test('overview reports repo, system and empty runs', async () => {
  await withServer(async (repo, srv) => {
    const res = await fetch(srv.url + '/api/overview');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.repo, repo);
    assert.ok(data.system.ncpu >= 1);
    assert.deepEqual(data.runs, []);
    assert.equal(data.current, null);
  });
});

test('overview renders a run with node states', async () => {
  await withServer(async (repo, srv) => {
    const graph = normalizeGraph({ goal: 'demo', nodes: [{ id: 'a', task: 'x' }, { id: 'b', command: 'echo b', deps: ['a'] }] });
    const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 2, model: null });
    state.nodes.a.status = 'done';
    state.nodes.a.startedAt = Date.now() - 3000;
    state.nodes.a.endedAt = Date.now() - 1000;
    state.nodes.b.status = 'running';
    state.nodes.b.startedAt = Date.now() - 500;
    saveState(dir, state);

    const data = await (await fetch(srv.url + '/api/overview')).json();
    assert.equal(data.runs.length, 1);
    assert.equal(data.current.id, state.runId);
    assert.equal(data.current.nodes.length, 2);
    assert.equal(data.current.nodes[0].status, 'done');
    assert.equal(data.current.nodes[1].status, 'running');
    assert.ok(data.hasGraph === false);
  });
});

test('rejects a plan request without a goal', async () => {
  await withServer(async (_repo, srv) => {
    const res = await fetch(srv.url + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 400);
  });
});

test('rejects running a missing graph', async () => {
  await withServer(async (_repo, srv) => {
    const res = await fetch(srv.url + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 400);
  });
});

test('log endpoint returns the tail of a node log', async () => {
  await withServer(async (repo, srv) => {
    const graph = normalizeGraph({ goal: 'demo', nodes: [{ id: 'a', task: 'x' }] });
    const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
    fs.writeFileSync(path.join(dir, 'logs', 'a.log'), 'line1\nline2\nline3\n');
    const data = await (await fetch(srv.url + '/api/log?run=' + state.runId + '&node=a&lines=2')).json();
    assert.equal(data.text, 'line2\nline3');
  });
});

test('stop without a running job returns a clear error', async () => {
  await withServer(async (_repo, srv) => {
    const res = await fetch(srv.url + '/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /nothing is running/);
  });
});

test('unknown route is a 404', async () => {
  await withServer(async (_repo, srv) => {
    const res = await fetch(srv.url + '/nope');
    assert.equal(res.status, 404);
  });
});
