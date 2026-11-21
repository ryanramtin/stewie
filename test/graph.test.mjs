import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, normalizeGraph, topoOrder, readyNodes, isDeadlocked, markBlocked, renderGraph } from '../src/graph.mjs';

const node = (id, extra = {}) => ({ id, task: `do ${id}`, deps: [], ...extra });

test('valid graph passes', () => {
  const r = validateGraph({ goal: 'g', nodes: [node('a'), node('b', { deps: ['a'] })] });
  assert.equal(r.ok, true, r.errors.join(','));
  assert.equal(r.graph.nodes[1].maxRetries, 1);
  assert.equal(r.graph.nodes[1].timeoutMs, 900000);
  assert.equal(r.graph.nodes[0].kind, 'agent');
});

test('shell nodes are inferred from command', () => {
  const r = validateGraph({ nodes: [{ id: 's', command: 'echo hi' }] });
  assert.equal(r.ok, true, r.errors.join(','));
  assert.equal(r.graph.nodes[0].kind, 'shell');
});

test('duplicate ids rejected', () => {
  const r = validateGraph({ nodes: [node('a'), node('a')] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /duplicate node id/);
});

test('unknown dependency rejected', () => {
  const r = validateGraph({ nodes: [node('a', { deps: ['ghost'] })] });
  assert.match(r.errors.join(), /unknown node "ghost"/);
});

test('self dependency rejected', () => {
  const r = validateGraph({ nodes: [node('a', { deps: ['a'] })] });
  assert.match(r.errors.join(), /depends on itself/);
});

test('cycle detected', () => {
  const r = validateGraph({ nodes: [node('a', { deps: ['c'] }), node('b', { deps: ['a'] }), node('c', { deps: ['b'] })] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /dependency cycle/);
});

test('missing task or command rejected', () => {
  const r = validateGraph({ nodes: [{ id: 'a' }, { id: 'b', kind: 'shell' }] });
  assert.match(r.errors.join(), /needs a "task"/);
  assert.match(r.errors.join(), /needs a "command"/);
});

test('empty graph rejected', () => {
  const r = validateGraph({ nodes: [] });
  assert.equal(r.ok, false);
});

test('bad id characters rejected', () => {
  const r = validateGraph({ nodes: [{ id: 'a b', task: 'x' }] });
  assert.match(r.errors.join(), /may only use/);
});

test('topo order puts dependencies first', () => {
  const g = normalizeGraph({ nodes: [node('c', { deps: ['b'] }), node('a'), node('b', { deps: ['a'] })] });
  assert.deepEqual(topoOrder(g.nodes).map((n) => n.id), ['a', 'b', 'c']);
});

test('readyNodes respects deps and backoff', () => {
  const g = normalizeGraph({ nodes: [node('a'), node('b', { deps: ['a'] })] });
  const st = {
    a: { status: 'pending', nextEligibleAt: 0 },
    b: { status: 'pending', nextEligibleAt: 0 },
  };
  assert.deepEqual(readyNodes(g.nodes, st).map((n) => n.id), ['a']);
  st.a.status = 'done';
  assert.deepEqual(readyNodes(g.nodes, st).map((n) => n.id), ['b']);
  st.b.nextEligibleAt = Date.now() + 60_000;
  assert.deepEqual(readyNodes(g.nodes, st), []);
});

test('markBlocked cascades from failures', () => {
  const g = normalizeGraph({ nodes: [node('a'), node('b', { deps: ['a'] }), node('c', { deps: ['b'] })] });
  const st = {
    a: { status: 'failed' },
    b: { status: 'pending' },
    c: { status: 'pending' },
  };
  const changed = markBlocked(g.nodes, st);
  assert.deepEqual(changed.sort(), ['b', 'c']);
  assert.equal(st.c.status, 'blocked');
  assert.equal(isDeadlocked(g.nodes, st), false);
});

test('isDeadlocked flags pending behind a failure', () => {
  const g = normalizeGraph({ nodes: [node('a'), node('b', { deps: ['a'] })] });
  const st = { a: { status: 'failed' }, b: { status: 'pending' } };
  assert.equal(isDeadlocked(g.nodes, st), true);
});

test('renderGraph is readable', () => {
  const g = normalizeGraph({ nodes: [node('a'), { id: 'v', command: 'pnpm test', deps: ['a'] }] });
  const out = renderGraph(g);
  assert.match(out, /a\s+\[agent\] deps=-/);
  assert.match(out, /v\s+\[shell\] deps=a/);
});
