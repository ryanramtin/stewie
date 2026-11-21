// Scheduler: dependency graph + bounded concurrency + system guard + retries.
// This is the "loop" that keeps long agentic work going without melting the box.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readyNodes, markBlocked } from './graph.mjs';
import { runProcess, shellCommand } from './exec.mjs';
import { saveState } from './state.mjs';

const POLL_MS = 4000;

export class Runner {
  constructor({ repoRoot, runDir, state, graph, guard, opts = {}, log = () => {} }) {
    this.repoRoot = repoRoot;
    this.runDir = runDir;
    this.state = state;
    this.graph = graph;
    this.guard = guard;
    this.opts = opts;
    this.log = log;
    this.inflight = new Map(); // id -> { heavy, startedAt }
    this.stopping = false;
    this.lastStartAt = Date.now();
    this.deadline = opts.budgetMin ? Date.now() + opts.budgetMin * 60_000 : null;
    this.childPids = new Set();
    this.lastWaitLog = 0;
  }

  stop(reason = 'signal') {
    this.stopping = true;
    this.stopReason = reason;
  }

  async run() {
    this.log(`run ${this.state.runId} · ${this.graph.nodes.length} nodes · concurrency ${this.state.concurrency}`);
    const pollMs = this.opts.pollMs ?? POLL_MS;
    while (!this.stopping) {
      if (this.deadline && Date.now() > this.deadline) {
        this.log('budget reached — stopping scheduler (finished nodes are kept)');
        break;
      }
      if (this.opts.maxRuns && this.state.stats.runs >= this.opts.maxRuns) {
        this.log('max node executions reached — stopping');
        break;
      }

      const blocked = markBlocked(this.graph.nodes, this.state.nodes);
      if (blocked.length) {
        this.log(`blocked: ${blocked.join(', ')}`);
        saveState(this.runDir, this.state);
      }

      const pending = this.graph.nodes.filter((n) => this.state.nodes[n.id].status === 'pending');
      if (!pending.length && this.inflight.size === 0) break;

      const ready = readyNodes(this.graph.nodes, this.state.nodes);
      if (!ready.length && this.inflight.size === 0) {
        // Nothing runnable: either nodes are cooling off before a retry, or the
        // graph is stuck behind failures. Wait for the backoff, never spin.
        const now = Date.now();
        const waiting = pending.filter((n) => (this.state.nodes[n.id].nextEligibleAt || 0) > now);
        if (waiting.length) {
          const until = Math.min(...waiting.map((n) => this.state.nodes[n.id].nextEligibleAt));
          await sleep(Math.min(until - now + 20, pollMs * 5));
          continue;
        }
        if (pending.length) this.log(`no runnable nodes left (${pending.map((n) => n.id).join(', ')}) — stopping`);
        break;
      }

      let startedThisTick = 0;
      const heavyRunning = [...this.inflight.values()].some((v) => v.heavy);

      for (const node of ready) {
        if (this.inflight.size >= this.state.concurrency) break;
        if (this.opts.failFast && this.state.nodes[node.id].status === 'pending' && this.anyFailed()) break;
        if (node.heavy && (heavyRunning || this.inflight.size > 0)) break;

        // stall protection: if everything has been waiting a long time, let one through
        const stalled = Date.now() - this.lastStartAt > this.opts.stallMs;
        const verdict = this.guard.canStart();
        if (!verdict.ok && !stalled) {
          if (Date.now() - this.lastWaitLog > 60_000) {
            this.log(`holding: ${verdict.reason}`);
            this.lastWaitLog = Date.now();
            this.state.stats.pauses += 1;
            saveState(this.runDir, this.state);
          }
          break;
        }
        if (!verdict.ok && stalled) {
          this.log(`machine still busy (${verdict.reason}) but stalled — starting one node anyway`);
        }

        this.startNode(node);
        startedThisTick += 1;
      }

      if (startedThisTick === 0) await sleep(pollMs);
      else await sleep(Math.min(250, pollMs));
    }

    if (this.inflight.size) {
      this.log(`waiting for ${this.inflight.size} running node(s) to finish…`);
      await Promise.all([...this.inflight.values()].map((v) => v.promise));
    }

    markBlocked(this.graph.nodes, this.state.nodes);
    saveState(this.runDir, this.state);
    return this.summary();
  }

  anyFailed() {
    return Object.values(this.state.nodes).some((n) => n.status === 'failed');
  }

  startNode(node) {
    const st = this.state.nodes[node.id];
    st.status = 'running';
    st.attempts += 1;
    st.startedAt = Date.now();
    st.endedAt = null;
    st.reason = null;
    this.state.stats.runs += 1;
    this.state.stats.retries += Math.max(0, st.attempts - 1);
    this.lastStartAt = Date.now();
    saveState(this.runDir, this.state);

    this.log(`▶ ${node.id} (${node.kind}, attempt ${st.attempts})`);
    const promise = this.executeNode(node)
      .catch((err) => {
        this.log(`✖ ${node.id} threw: ${err?.message ?? err}`);
        return { code: 1, stdout: '' };
      })
      .then((result) => this.finishNode(node, result));
    this.inflight.set(node.id, { heavy: node.heavy, startedAt: Date.now(), promise });
    promise.finally(() => this.inflight.delete(node.id));
  }

  promptFor(node) {
    const deps = node.deps
      .map((d) => {
        const summary = this.readSummary(d);
        return `### ${d} (done)\n${summary}`;
      })
      .join('\n\n');

    return [
      'You are one node in an automated task graph. Complete ONLY your task, then stop.',
      this.graph.goal ? `OVERALL GOAL: ${this.graph.goal}` : '',
      `YOUR NODE: ${node.id}`,
      `TASK: ${node.task}`,
      deps ? `WORK ALREADY COMPLETED:\n${deps}` : '',
      'RULES:',
      '- Work only inside this repository.',
      '- Do not commit, push, or run destructive commands.',
      '- If tests or typechecks exist, run the narrowest relevant one.',
      '- Finish with "SUMMARY:" followed by 3-6 lines: what you changed, what you verified, anything unfinished.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  readSummary(id) {
    try {
      const text = fs.readFileSync(path.join(this.runDir, 'logs', `${id}.summary.txt`), 'utf8');
      return text.trim().slice(0, 2000) || '(no summary)';
    } catch {
      return '(no summary)';
    }
  }

  async executeNode(node) {
    const logPath = path.join(this.runDir, 'logs', `${node.id}.log`);
    fs.writeFileSync(logPath, '');
    const env = { ...process.env, STEWIE_NODE: node.id, STEWIE_RUN: this.state.runId, STEWIE_ROOT: this.repoRoot };
    const cwd = node.cwd ? path.resolve(this.repoRoot, node.cwd) : this.repoRoot;

    let result;
    if (node.kind === 'shell') {
      const { command, args } = shellCommand(node.command);
      result = await runProcess({ command, args, cwd, env, timeoutMs: node.timeoutMs, logPath, nice: true });
    } else {
      const model = node.model ?? this.graph.model ?? this.state.model;
      const agent = node.agent ?? this.graph.agent ?? 'build';
      const args = ['run', '--agent', agent, '--auto'];
      if (model) args.push('--model', model);
      args.push(this.promptFor(node));
      result = await runProcess({
        command: process.env.STEWIE_OPENCODE_BIN ?? 'opencode',
        args,
        cwd,
        env,
        timeoutMs: node.timeoutMs,
        logPath,
        nice: true,
      });
    }

    fs.writeFileSync(path.join(this.runDir, 'logs', `${node.id}.summary.txt`), summarize(node, result));

    const verifyResults = [];
    if (result.code === 0) {
      for (const cmd of node.verify) {
        const vlog = path.join(this.runDir, 'logs', `${node.id}.verify.log`);
        const { command, args } = shellCommand(cmd);
        const v = await runProcess({ command, args, cwd, env, timeoutMs: node.timeoutMs, logPath: vlog, nice: true });
        verifyResults.push({ command: cmd, code: v.code, timedOut: v.timedOut });
        if (v.code !== 0) {
          result.code = v.code;
          break;
        }
      }
    }
    result.verify = verifyResults;
    return result;
  }

  finishNode(node, result) {
    const st = this.state.nodes[node.id];
    st.exitCode = result.code;
    st.verify = result.verify ?? [];
    st.endedAt = Date.now();
    this.captureDiff(node);

    const passed = result.code === 0 && (result.verify ?? []).every((v) => v.code === 0);
    if (passed) {
      st.status = 'done';
      st.reason = null;
      this.log(`✔ ${node.id} in ${((st.endedAt - st.startedAt) / 1000).toFixed(1)}s`);
    } else {
      const failedVerify = (result.verify ?? []).find((v) => v.code !== 0);
      st.reason = result.timedOut
        ? 'timeout'
        : failedVerify
          ? `verify failed: ${failedVerify.command}`
          : `exit ${result.code}`;

      if (st.attempts <= node.maxRetries) {
        st.status = 'pending';
        const base = this.opts.retryBaseMs ?? 5_000;
        st.nextEligibleAt = Date.now() + Math.min(60_000, base * 2 ** (st.attempts - 1));
        this.log(`↻ ${node.id} failed (${st.reason}) — retry ${st.attempts}/${node.maxRetries} in ${Math.round((st.nextEligibleAt - Date.now()) / 1000)}s`);
      } else {
        st.status = 'failed';
        this.state.stats.failures += 1;
        this.log(`✖ ${node.id} failed: ${st.reason}`);
      }
    }
    saveState(this.runDir, this.state);
  }

  captureDiff(node) {
    try {
      const stat = execFileSync('git', ['diff', 'HEAD', '--stat'], {
        cwd: this.repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!stat.trim()) return;
      const patch = execFileSync('git', ['diff', 'HEAD'], {
        cwd: this.repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const numstat = execFileSync('git', ['diff', 'HEAD', '--numstat'], {
        cwd: this.repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      fs.writeFileSync(path.join(this.runDir, 'diffs', `${node.id}.patch`), patch);
      fs.writeFileSync(path.join(this.runDir, 'diffs', `${node.id}.stat`), stat);
      fs.writeFileSync(path.join(this.runDir, 'diffs', `${node.id}.numstat`), numstat + this.untrackedNumstat());
    } catch {
      /* not a git repo, or nothing to diff */
    }
  }

  untrackedNumstat() {
    try {
      const files = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: this.repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .filter(Boolean)
        .filter((f) => !f.startsWith('.stewie/') && !f.includes('/node_modules/'))
        .slice(0, 200);
      let out = '';
      for (const file of files) {
        try {
          const text = fs.readFileSync(path.join(this.repoRoot, file), 'utf8');
          if (text.includes('\u0000')) continue;
          const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
          out += `${lines}\t0\t${file}\n`;
        } catch {
          /* unreadable, skip */
        }
      }
      return out;
    } catch {
      return '';
    }
  }

  summary() {
    const counts = {};
    for (const n of Object.values(this.state.nodes)) counts[n.status] = (counts[n.status] ?? 0) + 1;
    const ok = !counts.failed && !counts.blocked && !counts.pending;
    return { runId: this.state.runId, counts, complete: ok, dir: this.runDir };
  }
}

function summarize(node, result) {
  const out = result.stdout ?? '';
  const idx = out.lastIndexOf('SUMMARY:');
  const tail = idx >= 0 ? out.slice(idx + 8) : out.slice(-1500);
  return [
    `node: ${node.id}`,
    `kind: ${node.kind}`,
    `exit: ${result.code}${result.timedOut ? ' (timeout)' : ''}`,
    `duration: ${Math.round((result.durationMs ?? 0) / 1000)}s`,
    '',
    tail.trim().slice(0, 4000),
  ].join('\n');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
