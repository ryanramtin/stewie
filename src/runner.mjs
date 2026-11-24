// Scheduler: dependency graph + bounded concurrency + system guard + retries.
// This is the "loop" that keeps long agentic work going without melting the box.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readyNodes, markBlocked } from './graph.mjs';
import { runProcess, shellCommand } from './exec.mjs';
import { saveState } from './state.mjs';
import { askRepo, waitForAnswer, isApproval } from './inbox.mjs';
import { buildAgentCommand, engineFor } from './engines.mjs';
import { Budget, describeBudget } from './budget.mjs';
import { memoryPrompt, rememberNode, parseNumstat } from './memory.mjs';

const POLL_MS = 4000;

/**
 * A one-line desktop notification, so an inbox question or a dead run reaches a
 * person who is not looking at the screen. Silent elsewhere, and easy to turn off.
 */
export function notify(title, message) {
  if (process.env.STEWIE_NO_NOTIFY) return false;
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('osascript', ['-e', `display notification ${JSON.stringify(String(message))} with title ${JSON.stringify(String(title))}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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
    // Memory is on unless the graph, the node or the caller says otherwise.
    this.memory = opts.memory !== false;
    // What the working tree looked like before each node started, so a node is
    // credited with its own changes and not with the last node's.
    this.baseline = new Map();
    // The weekly ceiling: nothing starts when the week's allowance is used up.
    this.budget = new Budget(this.repoRoot).load(this.graph);
    this.budgetHit = null;
  }

  stop(reason = 'signal') {
    this.stopping = true;
    this.stopReason = reason;
  }

  async run() {
    this.log(`run ${this.state.runId} · ${this.graph.nodes.length} nodes · concurrency ${this.state.concurrency}`);
    if (this.budget.active) this.log(`ceiling: ${describeBudget(this.budget.limits, this.budget.ledger)}`);
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
        const afford = this.budget.canAfford(node);
        if (!afford.ok) {
          this.budgetHit = afford.reason;
          break;
        }
        if (this.opts.failFast && this.state.nodes[node.id].status === 'pending' && this.anyFailed()) break;
        if (node.heavy && (heavyRunning || this.inflight.size > 0)) break;

        // The guard holds until the machine is actually free. A long wait used to
        // start a node anyway; now it only explains how to override, and waits.
        const stalled = Date.now() - this.lastStartAt > (this.opts.stallMs ?? 3 * 60_000);
        const verdict = this.guard.canStart();
        if (!verdict.ok) {
          if (this.opts.forceStart) {
            this.log(`machine busy (${verdict.reason}) — --force-start, running anyway`);
          } else {
            if (Date.now() - this.lastWaitLog > 60_000) {
              const nudge = stalled ? ' (waiting a while — pass --force-start to override)' : '';
              this.log(`holding: ${verdict.reason}${nudge}`);
              this.lastWaitLog = Date.now();
              this.state.stats.pauses += 1;
              saveState(this.runDir, this.state);
            }
            break;
          }
        }

        this.startNode(node);
        startedThisTick += 1;
      }

      if (this.budgetHit) {
        this.log(`budget: ${this.budgetHit} — not starting more work this week`);
        try {
          askRepo(this.repoRoot, {
            kind: 'note',
            title: `weekly ceiling reached: ${this.budgetHit}`,
            detail: `run ${this.state.runId} stopped with ${Object.values(this.state.nodes).filter((n) => n.status === 'pending').length} node(s) still pending.\n\nSpent this week: ${describeBudget(this.budget.limits, this.budget.ledger)}\n\nThe ceiling resets Monday. Raise it in .stewie/budget.json or resume the run next week.`,
            askedBy: 'stewie runner',
            runId: this.state.runId,
          });
        } catch {
          /* the inbox is never a reason to fail a run */
        }
        break;
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
    this.baseline.set(node.id, this.numstatNow());
    // A tree of the working copy before this node touches anything, so its own
    // changes can be undone later without disturbing the rest of the run.
    st.baseTree = this.snapshotTree();
    saveState(this.runDir, this.state);

    const runs = node.kind === 'agent' ? engineFor(node, this.graph) : node.kind;
    this.log(`▶ ${node.id} (${runs}, attempt ${st.attempts})`);
    const promise = this.executeNode(node)
      .catch((err) => {
        this.log(`✖ ${node.id} threw: ${err?.message ?? err}`);
        return { code: 1, stdout: '' };
      })
      .then((result) => this.finishNode(node, result));
    this.inflight.set(node.id, { heavy: node.heavy, startedAt: Date.now(), promise });
    promise.finally(() => this.inflight.delete(node.id));
  }

  async askHuman(node) {
    const timeoutMs = Number(node.askTimeoutMs ?? this.graph.askTimeoutMs ?? 30 * 60_000);
    const options = Array.isArray(node.askOptions) && node.askOptions.length ? node.askOptions : ['allow', 'skip'];
    const requested = askRepo(this.repoRoot, {
      kind: 'question',
      title: typeof node.ask === 'string' ? node.ask : `Run ${node.id}?`,
      detail: node.task ?? node.command ?? '',
      options,
      askedBy: 'stewie runner',
      node: node.id,
      runId: this.state.runId,
      timeoutMs,
    });
    this.log(`✋ ${node.id} asks: ${requested.title} (inbox ${requested.id})`);
    const ping = this.opts.notify ?? notify;
    try { ping('stewie is waiting on you', `${node.id}: ${requested.title}`); } catch { /* notifications are optional */ }
    const st = this.state.nodes[node.id];
    if (st) {
      st.reason = 'waiting on you (inbox)';
      saveState(this.runDir, this.state);
    }
    const waited = await waitForAnswer(this.repoRoot, requested.id, { timeoutMs });
    if (st) {
      st.reason = null;
      saveState(this.runDir, this.state);
    }
    if (waited.status === 'answered') {
      this.log(`↳ you answered ${requested.id}: ${waited.answer.choice || '(note only)'}`);
      return { status: 'answered', choice: waited.answer.choice, note: waited.answer.note };
    }
    this.log(`↳ nobody answered ${requested.id} (${waited.status})`);
    return { status: waited.status };
  }

  promptFor(node) {
    const deps = node.deps
      .map((d) => {
        const summary = this.readSummary(d);
        return `### ${d} (done)\n${summary}`;
      })
      .join('\n\n');

    const remembered = this.memoryFor(node);

    return [
      'You are one node in an automated task graph. Complete ONLY your task, then stop.',
      this.graph.goal ? `OVERALL GOAL: ${this.graph.goal}` : '',
      `YOUR NODE: ${node.id}`,
      `TASK: ${node.task}`,
      deps ? `WORK ALREADY COMPLETED:\n${deps}` : '',
      remembered ? `MEMORY FROM EARLIER RUNS IN THIS REPO:\n${remembered}` : '',
      'RULES:',
      '- Work only inside this repository.',
      '- Do not commit, push, or run destructive commands.',
      '- If tests or typechecks exist, run the narrowest relevant one.',
      '- Use the memory above: do not repeat a dead end it already records, and reuse what worked.',
      '- If you learn something durable about this repo (the real test command, a trap, a decision), record it: `stewie memory add "<one line>"` (add `--lesson` for a mistake worth not repeating).',
      '- If a decision is a person\'s to make, ask: `stewie ask "<question>" --options allow,skip` and wait for the answer.',
      '- Finish with "SUMMARY:" followed by 3-6 lines: what you changed, what you verified, anything unfinished.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** What this node is allowed to remember, as a prompt block. Never throws. */
  memoryFor(node) {
    if (!this.memory || this.graph.memory === false || node.memory === false) return '';
    try {
      return memoryPrompt(this.repoRoot, { task: node.task || node.command, goal: this.graph.goal });
    } catch {
      return '';
    }
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

    // A node can be marked `"ask": true` (or with its own question). The scheduler
    // holds the slot and the run until a person answers in the inbox. It fails
    // closed: only an explicit yes runs the node. Skip, dismiss, another option or
    // a vanished request all mean no; an unanswered question fails the node.
    if (node.ask) {
      const options = Array.isArray(node.askOptions) && node.askOptions.length ? node.askOptions : ['allow', 'skip'];
      const answer = await this.askHuman(node);
      if (answer.status !== 'answered' || !isApproval(answer.choice, options)) {
        // A retry here would only ask the same question again.
        if (answer.status === 'missing') {
          return { code: 1, stdout: '', reason: 'the inbox request is gone — not running a gated node', noRetry: true };
        }
        if (answer.status === 'expired' || answer.status === 'timeout') {
          return { code: 1, stdout: '', reason: 'nobody answered the inbox question', noRetry: true };
        }
        return { code: 0, stdout: `not approved (${answer.status}${answer.choice ? `: ${answer.choice}` : ''})`, skipped: answer.choice || answer.status };
      }
    }

    let result;
    if (node.kind === 'shell') {
      const { command, args } = shellCommand(node.command);
      result = await runProcess({ command, args, cwd, env, timeoutMs: node.timeoutMs, logPath, nice: true });
    } else {
      const model = node.model ?? this.graph.model ?? this.state.model;
      const agent = node.agent ?? this.graph.agent ?? 'build';
      const { command, args } = buildAgentCommand({
        engine: engineFor(node, this.graph),
        prompt: this.promptFor(node),
        model,
        agent,
        extra: node.engineArgs ?? this.graph.engineArgs ?? [],
      });
      result = await runProcess({
        command,
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

    if (result.skipped) {
      st.status = 'done';
      st.reason = `skipped: ${result.skipped}`;
      st.exitCode = 0;
      st.verify = [];
      st.endedAt = Date.now();
      this.log(`⊘ ${node.id} skipped on your answer: ${result.skipped}`);
      this.remember(node, result);
      saveState(this.runDir, this.state);
      return;
    }

    st.exitCode = result.code;
    st.verify = result.verify ?? [];
    st.endedAt = Date.now();
    this.budget.spend({
      minutes: st.startedAt ? (st.endedAt - st.startedAt) / 60_000 : 0,
      money: node.cost ?? 0,
    });
    this.captureDiff(node);
    st.writes = this.changedSince(st.baseTree);

    const passed = result.code === 0 && (result.verify ?? []).every((v) => v.code === 0);
    if (passed) {
      st.status = 'done';
      st.reason = null;
      this.log(`✔ ${node.id} in ${((st.endedAt - st.startedAt) / 1000).toFixed(1)}s`);
    } else {
      const failedVerify = (result.verify ?? []).find((v) => v.code !== 0);
      st.reason = result.reason
        ? result.reason
        : result.timedOut
          ? 'timeout'
          : failedVerify
            ? `verify failed: ${failedVerify.command}`
            : `exit ${result.code}`;

      if (!result.noRetry && st.attempts <= node.maxRetries) {
        st.status = 'pending';
        const base = this.opts.retryBaseMs ?? 5_000;
        st.nextEligibleAt = Date.now() + Math.min(60_000, base * 2 ** (st.attempts - 1));
        this.log(`↻ ${node.id} failed (${st.reason}) — retry ${st.attempts}/${node.maxRetries} in ${Math.round((st.nextEligibleAt - Date.now()) / 1000)}s`);
      } else {
        st.status = 'failed';
        this.state.stats.failures += 1;
        this.log(`✖ ${node.id} failed: ${st.reason}`);
        const ping = this.opts.notify ?? notify;
        try { ping('stewie: a node failed', `${node.id}: ${st.reason}`); } catch { /* optional */ }
        // The graph cannot decide this one: it goes to the person's inbox so the
        // failure is not just a line in a log nobody reads.
        try {
          askRepo(this.repoRoot, {
            kind: 'note',
            title: `${node.id} failed: ${st.reason}`,
            detail: `run ${this.state.runId}\nnode ${node.id} (${node.kind})\n\n${(node.task ?? node.command ?? '').slice(0, 1200)}\n\nResume from the dashboard once you have decided.`,
            askedBy: 'stewie runner',
            node: node.id,
            runId: this.state.runId,
          });
        } catch {
          /* the inbox is never a reason to fail a node */
        }
      }
    }
    // Terminal outcomes are what later runs learn from; a retry that is still
    // in flight is not remembered yet.
    if (passed || st.status === 'failed') this.remember(node, result);
    saveState(this.runDir, this.state);
  }

  /** Write this node down for the next run. Memory never fails a node. */
  /** The working tree as a dangling commit, or HEAD when git has nothing to say. */
  snapshotTree() {
    try {
      const stashed = execFileSync('git', ['stash', 'create'], { cwd: this.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (stashed) return stashed;
    } catch {
      /* not a git repo */
    }
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  }

  /** Paths that differ between a base tree and the working copy right now. */
  changedSince(base) {
    if (!base) return [];
    const lines = (args) => {
      try {
        return execFileSync('git', args, { cwd: this.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
          .split('\n')
          .filter(Boolean);
      } catch {
        return [];
      }
    };
    const tracked = lines(['diff', '--name-only', base]);
    // Files the node created are untracked, so no diff against a tree names them.
    const created = lines(['ls-files', '--others', '--exclude-standard']).filter(
      (f) => !f.startsWith('.stewie/') && !f.includes('/node_modules/'),
    );
    return [...new Set([...tracked, ...created])];
  }

  remember(node, result) {
    try {
      const numstat = path.join(this.runDir, 'diffs', `${node.id}.numstat`);
      let text = '';
      try {
        text = fs.readFileSync(numstat, 'utf8');
      } catch {
        /* no diff captured (not a git repo, or nothing changed) */
      }
      rememberNode(this.repoRoot, {
        runId: this.state.runId,
        node,
        state: this.state.nodes[node.id],
        result,
        files: parseNumstat(text),
        summary: this.readSummary(node.id),
      });
    } catch {
      /* never a reason to fail a node */
    }
  }

  captureDiff(node) {
    try {
      const read = (args) =>
        execFileSync('git', args, {
          cwd: this.repoRoot,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      const stat = read(['diff', 'HEAD', '--stat']);
      const patch = read(['diff', 'HEAD']);
      const current = this.numstatNow();
      // The working tree may carry earlier nodes' edits. Only files whose line
      // counts moved since this node started belong to this node.
      const mine = subtractBaseline(current, this.baseline.get(node.id) ?? '');
      if (!stat.trim() && !patch.trim() && !mine) return;
      if (patch.trim()) fs.writeFileSync(path.join(this.runDir, 'diffs', `${node.id}.patch`), patch);
      if (stat.trim()) fs.writeFileSync(path.join(this.runDir, 'diffs', `${node.id}.stat`), stat);
      fs.writeFileSync(path.join(this.runDir, 'diffs', `${node.id}.numstat`), mine);
    } catch {
      /* not a git repo, or nothing to diff */
    }
  }

  /** `git diff HEAD --numstat` plus files that git does not track yet. */
  numstatNow() {
    try {
      const tracked = execFileSync('git', ['diff', 'HEAD', '--numstat'], {
        cwd: this.repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return tracked + this.untrackedNumstat();
    } catch {
      return '';
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

/** Lines in `current` that were not already in `baseline`, one occurrence at a time. */
function subtractBaseline(current, baseline) {
  if (!baseline.trim()) return current;
  const before = new Map();
  for (const line of baseline.split('\n')) {
    if (line.trim()) before.set(line, (before.get(line) ?? 0) + 1);
  }
  const out = [];
  for (const line of current.split('\n')) {
    if (!line.trim()) continue;
    const left = before.get(line) ?? 0;
    if (left > 0) {
      before.set(line, left - 1);
      continue;
    }
    out.push(line);
  }
  return out.length ? `${out.join('\n')}\n` : '';
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
