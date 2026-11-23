// Run calendar: the same disk state the console reads, folded into blocks on a
// time grid. A run is a block from its first worker start to its last worker end;
// each worker inside it keeps its own span, so a day shows what actually happened.

import fs from 'node:fs';
import path from 'node:path';
import { runsDir } from './state.mjs';

/** A run id is `YYYYMMDD-HHMMSS` in local time; that is enough to place it without reading the file. */
export function runStartFromId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** Week starting Monday, local midnight. */
export function startOfWeek(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  return d.getTime();
}

export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** What the run as a whole is doing, from its workers. */
export function runStatus(nodes) {
  const list = Object.values(nodes ?? {});
  if (list.some((n) => n.status === 'running')) return 'running';
  if (list.some((n) => n.status === 'failed')) return 'failed';
  if (list.some((n) => n.status === 'pending' || n.status === 'blocked')) return 'paused';
  return list.length ? 'done' : 'empty';
}

/**
 * Runs whose first worker started inside [from, to). `from`/`to` are epoch ms.
 * Only run folders whose id falls in the window are opened, so a year of runs
 * costs one directory listing.
 */
export function calendarRuns(repoRoot, { from, to, now = Date.now() } = {}) {
  const dir = runsDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const id of fs.readdirSync(dir)) {
    const guessed = runStartFromId(id);
    if (guessed == null) continue;
    // A run can be guessed slightly early (folder made a moment before the first
    // worker starts), so widen by an hour on the left and let the real times decide.
    if (guessed < from - 3_600_000 || guessed >= to) continue;
    const runDir = path.join(dir, id);
    const st = safeJson(path.join(runDir, 'state.json'));
    if (!st) continue;

    const graph = safeJson(path.join(runDir, 'graph.json'));
    const meta = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    const nodes = Object.entries(st.nodes ?? {}).map(([nid, n]) => {
      const g = meta.get(nid) ?? {};
      const start = n.startedAt ?? null;
      const end = n.endedAt ?? (n.status === 'running' ? now : null);
      return {
        id: nid,
        kind: g.kind ?? 'agent',
        heavy: Boolean(g.heavy),
        label: g.label ?? (g.kind === 'shell' ? g.command : g.task) ?? '',
        status: n.status ?? 'pending',
        attempts: n.attempts ?? 0,
        reason: n.reason ?? null,
        startedAt: start,
        endedAt: end,
      };
    });

    const started = nodes.map((n) => n.startedAt).filter((t) => t != null);
    const ended = nodes.map((n) => n.endedAt).filter((t) => t != null);
    const start = started.length ? Math.min(...started) : guessed;
    const end = ended.length ? Math.max(...ended) : null;
    if (start < from || start >= to) continue;

    const counts = {};
    for (const n of nodes) counts[n.status] = (counts[n.status] ?? 0) + 1;

    out.push({
      id,
      goal: st.goal ?? '',
      status: runStatus(st.nodes),
      startedAt: start,
      endedAt: end,
      createdAt: st.createdAt ?? null,
      counts,
      nodes: nodes.sort((a, b) => (a.startedAt ?? start) - (b.startedAt ?? start)),
      stats: st.stats ?? {},
      changes: countChanges(runDir, nodes),
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** Files and lines touched, summed from the last numstat each worker wrote. */
function countChanges(runDir, nodes) {
  let files = 0;
  let adds = 0;
  let deletes = 0;
  for (const n of nodes) {
    const file = path.join(runDir, 'diffs', `${n.id}.numstat`);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      const [a, d, p] = line.split('\t');
      if (!p) continue;
      files += 1;
      if (a !== '-') adds += Number(a) || 0;
      if (d !== '-') deletes += Number(d) || 0;
    }
  }
  return { files, adds, deletes };
}

/** Default window for the dashboard: this week, or a single day when asked. */
export function windowFor(anchor = Date.now(), days = 7) {
  const from = days === 1 ? startOfDay(anchor) : startOfWeek(anchor);
  return { from, to: addDays(from, days) };
}
