// Durable run state: every node transition is written to disk so a crash
// (or Ctrl-C) costs nothing — `stewie resume` picks up exactly where it stopped.

import fs from 'node:fs';
import path from 'node:path';

export function runsDir(repoRoot) {
  return path.join(repoRoot, '.stewie', 'runs');
}

export function newRunId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function initState({ runId, goal, graphPath, concurrency, model }) {
  return {
    version: 1,
    runId,
    goal,
    graphPath,
    concurrency,
    model,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: { runs: 0, retries: 0, failures: 0, pauses: 0 },
    nodes: {},
  };
}

export function createRun(repoRoot, { graph, graphPath, concurrency, model }) {
  const runId = newRunId();
  const dir = path.join(runsDir(repoRoot), runId);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'diffs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph, null, 2) + '\n');

  const state = initState({ runId, goal: graph.goal, graphPath, concurrency, model });
  for (const n of graph.nodes) {
    state.nodes[n.id] = {
      status: 'pending',
      attempts: 0,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      verify: [],
      nextEligibleAt: 0,
      reason: null,
    };
  }
  saveState(dir, state);
  fs.writeFileSync(path.join(repoRoot, '.stewie', 'latest'), runId + '\n');
  return { runId, dir, state };
}

export function saveState(dir, state) {
  state.updatedAt = new Date().toISOString();
  const tmp = path.join(dir, 'state.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, path.join(dir, 'state.json'));
}

export function loadState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

export function loadGraph(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
}

export function latestRun(repoRoot) {
  try {
    const id = fs.readFileSync(path.join(repoRoot, '.stewie', 'latest'), 'utf8').trim();
    return id || null;
  } catch {
    return null;
  }
}

export function resolveRunDir(repoRoot, runId) {
  const id = runId ?? latestRun(repoRoot);
  if (!id) return null;
  const dir = path.join(runsDir(repoRoot), id);
  return fs.existsSync(dir) ? dir : null;
}
