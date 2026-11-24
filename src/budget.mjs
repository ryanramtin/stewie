// The ceiling: a weekly cap on how much work the runner may start.
//
// Nodes and minutes are measured directly. Money is only as good as what a graph
// declares — a node with no `cost` is free, which is the honest default when the
// work runs on a subscription or a free tier. The ledger lives on disk so a cap
// survives restarts and applies across runs, not just inside one.
//
// Limits come from `.stewie/budget.json`, and a graph may tighten them in its own
// `budget` block. Omitted or zero means no cap for that unit.

import fs from 'node:fs';
import path from 'node:path';

export function budgetPath(repoRoot) {
  return path.join(repoRoot, '.stewie', 'budget.json');
}

export function ledgerPath(repoRoot) {
  return path.join(repoRoot, '.stewie', 'ledger.json');
}

/** Monday, local midnight, as YYYY-MM-DD. The week the caps are measured over. */
export function weekStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function positive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** The limits in force: the file, tightened by the graph, never loosened by it. */
export function loadLimits(repoRoot, graph = {}) {
  const file = readJson(budgetPath(repoRoot)) ?? {};
  const graphLimits = graph?.budget ?? {};
  const pick = (key) => {
    const a = positive(graphLimits[key]);
    const b = positive(file[key]);
    if (a && b) return Math.min(a, b);
    return a || b || 0;
  };
  return { nodes: pick('nodes'), minutes: pick('minutes'), money: pick('money') };
}

export function loadLedger(repoRoot, now = Date.now()) {
  const week = weekStart(now);
  const saved = readJson(ledgerPath(repoRoot));
  if (!saved || saved.weekStart !== week) return { weekStart: week, nodes: 0, minutes: 0, money: 0 };
  return {
    weekStart: week,
    nodes: Number(saved.nodes) || 0,
    minutes: Number(saved.minutes) || 0,
    money: Number(saved.money) || 0,
  };
}

export function saveLedger(repoRoot, ledger) {
  const file = ledgerPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function writeLimits(repoRoot, limits) {
  const file = budgetPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean = {};
  for (const key of ['nodes', 'minutes', 'money']) {
    const v = positive(limits[key]);
    if (v) clean[key] = v;
  }
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

/** A one-line state: limits, spend this week, and what is left. */
export function describeBudget(limits, ledger) {
  const parts = [];
  for (const [key, unit] of [['nodes', 'nodes'], ['minutes', 'min'], ['money', '$']]) {
    const limit = limits[key];
    if (!limit) continue;
    const spent = Math.round((ledger[key] ?? 0) * 100) / 100;
    const left = Math.round((limit - spent) * 100) / 100;
    parts.push(`${key} ${spent}/${limit}${unit === '$' ? ' usd' : ''} (${left} left)`);
  }
  return parts.length ? parts.join(' · ') : 'no ceiling set';
}

/**
 * Tracks this week's spend and answers whether one more node fits. The ledger is
 * written on every change, so a crash cannot hand back budget already spent.
 */
export class Budget {
  constructor(repoRoot, { now = () => Date.now() } = {}) {
    this.repoRoot = repoRoot;
    this.now = now;
    this.limits = { nodes: 0, minutes: 0, money: 0 };
    this.ledger = { weekStart: weekStart(now()), nodes: 0, minutes: 0, money: 0 };
  }

  load(graph = {}) {
    this.limits = loadLimits(this.repoRoot, graph);
    this.ledger = loadLedger(this.repoRoot, this.now());
    return this;
  }

  get active() {
    return Boolean(this.limits.nodes || this.limits.minutes || this.limits.money);
  }

  /** Whether starting this node would stay inside the caps. */
  canAfford(node = {}) {
    const l = this.limits;
    if (l.nodes && this.ledger.nodes + 1 > l.nodes) return { ok: false, reason: `node ceiling ${l.nodes} reached` };
    if (l.minutes && this.ledger.minutes >= l.minutes) return { ok: false, reason: `minute ceiling ${l.minutes} reached` };
    const cost = positive(node.cost);
    if (l.money && cost && this.ledger.money + cost > l.money) {
      return { ok: false, reason: `money ceiling $${l.money} reached` };
    }
    return { ok: true };
  }

  /** Record what a finished node used. Returns the updated ledger. */
  spend({ minutes = 0, money = 0 } = {}) {
    this.ledger.nodes += 1;
    this.ledger.minutes += Number(minutes) || 0;
    this.ledger.money += Number(money) || 0;
    // Round to keep the file readable over a long week.
    this.ledger.minutes = Math.round(this.ledger.minutes * 100) / 100;
    this.ledger.money = Math.round(this.ledger.money * 100) / 100;
    saveLedger(this.repoRoot, this.ledger);
    return this.ledger;
  }

  summary() {
    return { limits: this.limits, ledger: this.ledger };
  }
}
