// System guard: decides whether it is safe to start another process.
// Hard rule: never let the orchestrator be the reason the machine swaps or freezes.

import os from 'node:os';
import { execFileSync } from 'node:child_process';

const CACHE_MS = 3000;
let cache = { at: 0, freeBytes: 0 };

function pageStats() {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache;
  let freeBytes = os.freemem();
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8' });
      const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const pages = (label) => {
        const m = new RegExp(`${label}:\\s+(\\d+)`).exec(out);
        return m ? Number(m[1]) : 0;
      };
      const free = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative');
      freeBytes = free * pageSize;
    }
  } catch {
    /* fall back to os.freemem */
  }
  cache = { at: now, freeBytes };
  return cache;
}

export function systemSnapshot(limits = {}) {
  const totalBytes = os.totalmem();
  const { freeBytes } = pageStats();
  const load1 = os.loadavg()[0];
  const ncpu = os.cpus().length || 1;
  const minFreeBytes = limits.minFreeBytes ?? Math.max(1.5 * 1024 ** 3, totalBytes * 0.1);
  const maxLoad = limits.maxLoad ?? ncpu * (limits.loadFactor ?? 1.0);

  const reasons = [];
  if (freeBytes < minFreeBytes) {
    reasons.push(`free RAM ${gb(freeBytes)}GB < ${gb(minFreeBytes)}GB`);
  }
  if (load1 > maxLoad) {
    reasons.push(`load ${load1.toFixed(2)} > ${maxLoad.toFixed(2)} (${ncpu} cores)`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    freeBytes,
    totalBytes,
    load1,
    ncpu,
    minFreeBytes,
    maxLoad,
  };
}

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(2);
}

export function describeSystem(s) {
  return `${s.ncpu} cores · load ${s.load1.toFixed(2)}/${s.maxLoad.toFixed(1)} · free ${gb(s.freeBytes)}GB of ${gb(s.totalBytes)}GB`;
}

/** Default parallelism for this machine: never more than a quarter of the cores, capped at 3. */
export function defaultConcurrency(ncpu = os.cpus().length || 1) {
  return Math.max(1, Math.min(3, Math.floor(ncpu / 4)));
}

export class Guard {
  constructor(limits = {}) {
    this.limits = limits;
    this.paused = 0;
  }

  check() {
    return systemSnapshot(this.limits);
  }

  /** True when a new process may start. */
  canStart() {
    const s = this.check();
    if (s.ok) return { ok: true, snapshot: s };
    this.paused += 1;
    return { ok: false, reason: s.reasons.join('; '), snapshot: s };
  }
}
