// Task graph: validation, normalization, dependency resolution.

const DEFAULTS = {
  maxRetries: 1,
  timeoutMs: 15 * 60 * 1000,
  deps: [],
  verify: [],
  agent: 'build',
};

const HEAVY_COMMAND = /\b(test|typecheck|type-check|lint|build|compile|tsc|jest|vitest|pytest|make|cargo|gradle|xcodebuild|expo|eas)\b/i;

export function looksHeavy(command, verify = []) {
  return verify.length > 0 || HEAVY_COMMAND.test(command ?? '');
}

export function normalizeNode(raw) {
  const kind = raw.kind ?? (raw.command ? 'shell' : 'agent');
  return {
    id: String(raw.id ?? ''),
    kind,
    task: String(raw.task ?? ''),
    command: String(raw.command ?? ''),
    deps: [...(raw.deps ?? DEFAULTS.deps)].map(String),
    verify: [...(raw.verify ?? DEFAULTS.verify)].map(String),
    model: raw.model ?? null,
    agent: raw.agent ?? DEFAULTS.agent,
    maxRetries: Number.isFinite(raw.maxRetries) ? raw.maxRetries : DEFAULTS.maxRetries,
    timeoutMs: Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : DEFAULTS.timeoutMs,
    heavy: raw.heavy ?? (kind === 'shell' ? looksHeavy(raw.command, raw.verify ?? []) : (raw.verify ?? []).length > 0),
    cwd: raw.cwd ?? null,
    label: raw.label ?? null,
    // A question for a person before this node runs: true, or the question itself.
    ask: raw.ask ?? null,
    askOptions: Array.isArray(raw.askOptions) ? raw.askOptions.map(String).slice(0, 6) : null,
    askTimeoutMs: Number.isFinite(raw.askTimeoutMs) ? raw.askTimeoutMs : null,
    // Memory from earlier runs is in the prompt unless this node opts out.
    memory: raw.memory !== false,
  };
}

export function normalizeGraph(graph) {
  const g = graph && typeof graph === 'object' ? graph : {};
  return {
    goal: String(g.goal ?? ''),
    model: g.model ?? null,
    agent: g.agent ?? null,
    concurrency: Number.isFinite(g.concurrency) ? g.concurrency : null,
    askTimeoutMs: Number.isFinite(g.askTimeoutMs) ? g.askTimeoutMs : null,
    memory: g.memory !== false,
    nodes: (Array.isArray(g.nodes) ? g.nodes : []).map(normalizeNode),
  };
}

/** Returns { ok, errors, graph } — graph is normalized. */
export function validateGraph(input) {
  const graph = normalizeGraph(input);
  const errors = [];
  const nodes = graph.nodes;

  if (!nodes.length) errors.push('graph needs a non-empty "nodes" array');

  const ids = new Set();
  for (const n of nodes) {
    if (!n.id) {
      errors.push(`node is missing an "id": ${JSON.stringify(n).slice(0, 100)}`);
      continue;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(n.id)) errors.push(`node id "${n.id}" may only use letters, numbers, . _ -`);
    if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (n.kind === 'agent' && !n.task) errors.push(`agent node "${n.id}" needs a "task"`);
    if (n.kind === 'shell' && !n.command) errors.push(`shell node "${n.id}" needs a "command"`);
    if (!['agent', 'shell'].includes(n.kind)) errors.push(`node "${n.id}" has invalid kind "${n.kind}" (agent|shell)`);
  }

  for (const n of nodes) {
    for (const d of n.deps) {
      if (!ids.has(d)) errors.push(`node "${n.id}" depends on unknown node "${d}"`);
      if (d === n.id) errors.push(`node "${n.id}" depends on itself`);
    }
  }

  const cycle = findCycle(nodes);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);

  return { ok: errors.length === 0, errors, graph };
}

function findCycle(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map();
  const stack = [];

  const visit = (id) => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') {
      const i = stack.indexOf(id);
      return [...stack.slice(i), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.deps ?? []) {
      if (!byId.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const n of nodes) {
    const found = visit(n.id);
    if (found) return found;
  }
  return null;
}

/** Node ids in dependency order (deps first). Throws on cycles. */
export function topoOrder(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = [];
  const seen = new Set();
  const walk = (n) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    for (const d of n.deps) if (byId.has(d)) walk(byId.get(d));
    out.push(n);
  };
  for (const n of nodes) walk(n);
  return out;
}

/** Nodes whose deps are all done and which are not currently running. */
export function readyNodes(nodes, nodeState, now = Date.now()) {
  return nodes.filter((n) => {
    const s = nodeState[n.id];
    if (!s || s.status !== 'pending') return false;
    if (s.nextEligibleAt && now < s.nextEligibleAt) return false;
    return n.deps.every((d) => nodeState[d]?.status === 'done');
  });
}

/** A node can never run because a dependency will never finish. */
export function isDeadlocked(nodes, nodeState) {
  const terminal = (s) => ['failed', 'blocked', 'skipped'].includes(s?.status);
  return nodes.some((n) => {
    const s = nodeState[n.id];
    return s?.status === 'pending' && n.deps.some((d) => terminal(nodeState[d]));
  });
}

/** Mark pending nodes with failed/blocked ancestors as blocked. Returns changed ids. */
export function markBlocked(nodes, nodeState) {
  const changed = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of nodes) {
      const s = nodeState[n.id];
      if (s?.status !== 'pending') continue;
      if (n.deps.some((d) => ['failed', 'blocked', 'skipped'].includes(nodeState[d]?.status))) {
        s.status = 'blocked';
        s.endedAt = Date.now();
        s.reason = `blocked by ${n.deps.find((d) => ['failed', 'blocked', 'skipped'].includes(nodeState[d]?.status))}`;
        changed.push(n.id);
        progress = true;
      }
    }
  }
  return changed;
}

export function renderGraph(graph) {
  const nodes = graph.nodes;
  const width = Math.max(2, ...nodes.map((n) => n.id.length));
  const lines = [];
  for (const n of topoOrder(nodes)) {
    const deps = n.deps.length ? n.deps.join(',') : '-';
    const label = n.label ?? (n.kind === 'shell' ? n.command : n.task).slice(0, 60);
    lines.push(`${n.id.padEnd(width)}  [${n.kind}] deps=${deps}  ${label}`);
  }
  return lines.join('\n');
}
