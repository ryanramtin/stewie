// Local dashboard: the window on top of the graph engine.
// Loopback only, no dependencies, no file watchers — the page polls small JSON.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { systemSnapshot } from './guard.mjs';
import { runsDir, loadState, loadGraph, resolveRunDir } from './state.mjs';
import { renderGraph } from './graph.mjs';
import { dashboardHtml } from './ui.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stewie.mjs');
const MAX_JOB_OUTPUT = 20 * 1024;

export function startServer({ repoRoot, port = 4321, host = '127.0.0.1', open = true, openPath = '/', log = () => {} }) {
  const jobs = new Map();
  let activeRun = null; // child process for a run

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, dashboardHtml());
      if (req.method === 'GET' && url.pathname === '/api/overview') return sendJson(res, overview(repoRoot, url.searchParams.get('run')));
      if (req.method === 'GET' && url.pathname === '/api/log') return sendJson(res, logTail(repoRoot, url.searchParams));
      if (req.method === 'GET' && url.pathname === '/api/jobs') return sendJson(res, [...jobs.values()].slice(-20));
      if (req.method === 'POST' && url.pathname === '/api/plan') return handle(req, res, async (body) => {
        const goal = String(body.goal ?? '').trim();
        if (!goal) return sendJson(res, { error: 'goal is required' }, 400);
        const job = startJob('plan', [BIN, 'plan', goal, '--out', '.stewie/graph.json'], body.execute);
        sendJson(res, { job: job.id });
      });
      if (req.method === 'POST' && url.pathname === '/api/run') return handle(req, res, async (body) => {
        const graph = String(body.graph ?? '.stewie/graph.json');
        if (!fs.existsSync(path.resolve(repoRoot, graph))) return sendJson(res, { error: `no graph at ${graph}` }, 400);
        const conc = Number(body.concurrency ?? 2);
        const job = startJob('run', [BIN, 'run', graph, '--concurrency', String(conc)]);
        sendJson(res, { job: job.id });
      });
      if (req.method === 'POST' && url.pathname === '/api/resume') return handle(req, res, async () => {
        const job = startJob('resume', [BIN, 'resume']);
        sendJson(res, { job: job.id });
      });
      if (req.method === 'POST' && url.pathname === '/api/stop') return handle(req, res, async (body) => {
        if (!activeRun?.pid) return sendJson(res, { error: 'nothing is running' }, 400);
        const hard = Boolean(body.hard);
        try {
          process.kill(-activeRun.pid, hard ? 'SIGKILL' : 'SIGINT');
        } catch {
          try {
            activeRun.kill(hard ? 'SIGKILL' : 'SIGINT');
          } catch { /* gone */ }
        }
        sendJson(res, { stopped: true, hard });
      });
      return sendJson(res, { error: 'not found' }, 404);
    } catch (err) {
      return sendJson(res, { error: err.message }, 500);
    }
  });

  function startJob(type, argv, chainRun = false) {
    const id = `${type}-${Date.now().toString(36)}`;
    const job = { id, type, status: 'running', startedAt: Date.now(), endedAt: null, output: '', pid: null };
    jobs.set(id, job);

    const child = spawn(process.execPath, argv, { cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    job.pid = child.pid;
    if (type === 'run' || type === 'resume') activeRun = child;

    const append = (d) => {
      job.output = (job.output + d.toString()).slice(-MAX_JOB_OUTPUT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => {
      job.status = code === 0 ? 'done' : 'failed';
      job.endedAt = Date.now();
      if (activeRun === child) activeRun = null;
      if (chainRun && code === 0) startJob('run', [BIN, 'run', '.stewie/graph.json', '--concurrency', '2']);
    });
    return job;
  }

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && port < 4399) {
        server.removeListener('error', onError);
        resolve(startServer({ repoRoot, port: port + 1, open, log }));
      } else reject(err);
    };
    server.on('error', onError);
    server.listen(port, host, () => {
      const actual = server.address().port;
      const shown = host === '0.0.0.0' ? lanAddress() ?? '127.0.0.1' : host;
      const url = `http://${shown}:${actual}`;
      log(`dashboard ${url}`);
      if (open) {
        try {
          execFileSync('open', [url + openPath]);
        } catch { /* headless */ }
      }
      resolve({
        url,
        port: actual,
        close: () =>
          new Promise((r) => {
            if (activeRun?.pid) {
              try {
                process.kill(-activeRun.pid, 'SIGINT');
              } catch { /* gone */ }
            }
            server.close(r);
          }),
        jobs,
      });
    });
  });
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

// ---------------------------------------------------------------- data

function overview(root, runParam) {
  const snap = systemSnapshot();
  const runs = listRuns(root);
  const currentId = runParam || runs[0]?.id || null;
  const current = currentId ? readRun(root, currentId) : null;
  const graph = current ? safeJson(path.join(runsDir(root), current.id, 'graph.json')) : null;

  return {
    repo: root,
    system: {
      ncpu: snap.ncpu,
      load1: snap.load1,
      maxLoad: snap.maxLoad,
      freeBytes: snap.freeBytes,
      totalBytes: snap.totalBytes,
      ok: snap.ok,
      reasons: snap.reasons,
    },
    runs,
    current: current
      ? {
          ...current,
          nodes: (graph?.nodes ?? []).map((n) => ({
            id: n.id,
            kind: n.kind,
            deps: n.deps,
            heavy: n.heavy,
            label: n.label ?? (n.kind === 'shell' ? n.command : n.task).slice(0, 90),
            verify: n.verify,
            changes: readChanges(current.dir, n.id),
            ...(current.nodes?.[n.id] ?? {}),
          })),
          graphText: graph ? renderGraph({ nodes: graph.nodes }) : '',
        }
      : null,
    hasGraph: fs.existsSync(path.join(root, '.stewie', 'graph.json')),
    checks: detectChecks(root),
  };
}

function listRuns(root) {
  const dir = runsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((id) => fs.existsSync(path.join(dir, id, 'state.json')))
    .sort()
    .reverse()
    .slice(0, 25)
    .map((id) => {
      const st = safeJson(path.join(dir, id, 'state.json'));
      const nodes = Object.values(st?.nodes ?? {});
      const counts = {};
      for (const n of nodes) counts[n.status] = (counts[n.status] ?? 0) + 1;
      return { id, goal: st?.goal ?? '', createdAt: st?.createdAt ?? '', counts, total: nodes.length };
    });
}

function readRun(root, id) {
  const dir = resolveRunDir(root, id);
  if (!dir) return null;
  const st = loadState(dir);
  return { id: st.runId, goal: st.goal, createdAt: st.createdAt, updatedAt: st.updatedAt, stats: st.stats, nodes: st.nodes, dir };
}

/** Files touched by a node, from the numstat captured when it finished. */
function readChanges(dir, nodeId) {
  const file = path.join(dir, 'diffs', `${nodeId}.numstat`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [adds, dels, p] = line.split('\t');
      return {
        path: p ?? '',
        adds: adds === '-' ? 0 : Number(adds) || 0,
        deletes: dels === '-' ? 0 : Number(dels) || 0,
        binary: adds === '-',
      };
    })
    .filter((c) => c.path);
}

function logTail(root, params) {
  const run = params.get('run');
  const node = params.get('node');
  const lines = Math.min(400, Number(params.get('lines') ?? 120));
  if (!run || !node) return { error: 'run and node are required' };
  const dir = resolveRunDir(root, run);
  if (!dir) return { error: 'run not found' };
  const file = path.join(dir, 'logs', `${node}.log`);
  if (!fs.existsSync(file)) return { text: '' };
  const text = tailFile(file, 96 * 1024);
  return { text: text.replace(/\n$/, '').split('\n').slice(-lines).join('\n') };
}

function tailFile(file, maxBytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

function detectChecks(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const pm = fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm';
    return ['typecheck', 'lint', 'test'].filter((s) => pkg.scripts?.[s]).map((s) => `${pm} ${s}`);
  } catch {
    return [];
  }
}

function safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- http helpers

function sendJson(res, body, code = 200) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function handle(req, res, fn) {
  let body = '';
  req.on('data', (d) => {
    body += d;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', async () => {
    let parsed = {};
    if (body.trim()) {
      try {
        parsed = JSON.parse(body);
      } catch {
        return sendJson(res, { error: 'invalid JSON' }, 400);
      }
    }
    try {
      await fn(parsed);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
  });
}
