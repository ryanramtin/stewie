#!/usr/bin/env node
// stewie — bounded task-graph runner for OpenCode.
// Parity behaviours: plan mode, durable runs, parallel workers, verify gates,
// hard concurrency limits, and a system guard that refuses to swap the machine.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateGraph, renderGraph } from '../src/graph.mjs';
import { Guard, defaultConcurrency, systemSnapshot, describeSystem } from '../src/guard.mjs';
import { createRun, resolveRunDir, loadState, loadGraph } from '../src/state.mjs';
import { Runner } from '../src/runner.mjs';
import { startServer } from '../src/server.mjs';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const log = (msg) => console.log(`${C.dim(new Date().toLocaleTimeString())} ${msg}`);
const die = (msg) => {
  console.error(C.red(`stewie: ${msg}`));
  process.exit(1);
};

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return process.cwd();
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function readGraphFile(file, root) {
  const p = path.resolve(root, file);
  if (!fs.existsSync(p)) die(`no graph at ${path.relative(root, p)} — run \`stewie init\` or \`stewie plan "<goal>"\``);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    die(`graph is not valid JSON: ${err.message}`);
  }
  const { ok, errors, graph } = validateGraph(raw);
  if (!ok) die(`invalid graph:\n  - ${errors.join('\n  - ')}`);
  return { graph, path: p };
}

// ---------------------------------------------------------------- init

function cmdInit({ positional, flags }) {
  const root = repoRoot();
  const file = path.resolve(root, positional[0] ?? '.stewie/graph.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !flags.force) die(`${path.relative(root, file)} already exists (use --force to overwrite)`);

  const template = {
    goal: flags.goal ?? 'Describe the outcome you want',
    concurrency: defaultConcurrency(),
    nodes: [
      {
        id: 'explore',
        task: 'Read the repository and report the structure, the test commands, and the risky areas for the goal.',
        verify: [],
      },
      {
        id: 'implement',
        deps: ['explore'],
        task: 'Implement the goal inside this repo. Keep edits focused.',
        verify: ['echo "replace me with: npm test"'],
      },
      {
        id: 'verify',
        deps: ['implement'],
        kind: 'shell',
        command: 'echo "replace me with: pnpm typecheck && pnpm test"',
      },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(template, null, 2) + '\n');

  const gitignore = path.join(root, '.gitignore');
  const ignoreLine = '.stewie/';
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!current.split('\n').includes(ignoreLine)) fs.appendFileSync(gitignore, (current && !current.endsWith('\n') ? '\n' : '') + ignoreLine + '\n');

  console.log(`created ${path.relative(root, file)}`);
  console.log(C.dim(`next: edit the nodes, then \`stewie run\` (or \`stewie plan "<goal>"\`)`));
}

// ---------------------------------------------------------------- graph

function cmdGraph({ positional, flags }) {
  const root = repoRoot();
  const { graph, path: p } = readGraphFile(positional[0] ?? flags.graph ?? '.stewie/graph.json', root);
  console.log(C.bold(path.relative(root, p)));
  if (graph.goal) console.log(C.dim(`goal: ${graph.goal}`));
  console.log(renderGraph(graph));
}

// ---------------------------------------------------------------- plan

function cmdPlan({ positional, flags }) {
  const root = repoRoot();
  const goal = positional.join(' ').trim();
  if (!goal) die('usage: stewie plan "<goal>"');
  const out = path.resolve(root, flags.out ?? '.stewie/graph.json');
  const model = flags.model ?? process.env.STEWIE_PLAN_MODEL ?? 'opencode-go/deepseek-v4.1-flash';

  const prompt = [
    'Create an execution graph for this coding goal, as JSON only.',
    `GOAL: ${goal}`,
    '',
    'Respond with a single JSON object and nothing else, in this shape:',
    `{"goal":"...","nodes":[{"id":"short-id","task":"what this worker must do","deps":[],"verify":["command"]}]}`,
    '',
    'Rules:',
    '- 2 to 6 nodes, ids are short kebab-case, dependencies only reference earlier ids.',
    '- Node 1 always explores and reports the repo (test commands, risky areas).',
    '- The last node is a shell node that runs the real check command(s).',
    '- Verification commands must be real commands that will work in this repo.',
    '- Keep independent nodes parallel-friendly (they run concurrently).',
  ].join('\n');

  log(`planning with ${model}…`);
  let stdout = '';
  try {
    stdout = execFileSync(process.env.STEWIE_OPENCODE_BIN ?? 'opencode', ['run', '--agent', 'planner', '--auto', '--model', model, prompt], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
  } catch (err) {
    die(`planner failed: ${err.message.split('\n')[0]}`);
  }

  const json = extractJson(stdout);
  if (!json) die(`planner did not return JSON. Raw output:\n${stdout.slice(0, 1200)}`);
  const { ok, errors, graph } = validateGraph(json);
  if (!ok) die(`planner produced an invalid graph:\n  - ${errors.join('\n  - ')}`);
  if (!graph.concurrency) graph.concurrency = defaultConcurrency();

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(graph, null, 2) + '\n');
  console.log(C.green(`wrote ${path.relative(root, out)}`));
  console.log(renderGraph(graph));
}

function extractJson(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text].filter(Boolean);
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* keep trying */
    }
  }
  return null;
}

// ---------------------------------------------------------------- run / resume

async function cmdRun({ positional, flags }) {
  const root = repoRoot();
  const { graph, path: graphPath } = readGraphFile(positional[0] ?? flags.graph ?? '.stewie/graph.json', root);

  const concurrency = Number(flags.concurrency ?? graph.concurrency ?? defaultConcurrency());
  if (!Number.isFinite(concurrency) || concurrency < 1) die('--concurrency must be >= 1');

  const snap = systemSnapshot();
  console.log(C.bold(`stewie run · ${graph.nodes.length} nodes · concurrency ${concurrency}`));
  console.log(C.dim(describeSystem(snap)));
  if (!snap.ok && !flags.force) {
    console.log(C.yellow(`machine is busy (${snap.reasons.join('; ')}) — will hold until it frees up`));
  }

  if (flags['dry-run']) {
    console.log(renderGraph(graph));
    console.log(C.dim('\ndry run: nothing executed'));
    return 0;
  }

  const { runId, dir, state } = createRun(root, {
    graph,
    graphPath,
    concurrency,
    model: flags.model ?? graph.model ?? null,
  });
  log(`run ${runId} → ${path.relative(root, dir)}`);

  return driveRunner({ root, dir, state, graph, flags });
}

async function cmdResume({ positional, flags }) {
  const root = repoRoot();
  const dir = resolveRunDir(root, positional[0]);
  if (!dir) die('no run to resume');
  const state = loadState(dir);
  const graph = loadGraph(dir);
  const pending = Object.values(state.nodes).filter((n) => n.status === 'pending' || n.status === 'running');
  for (const n of Object.values(state.nodes)) {
    if (n.status === 'running') n.status = 'pending'; // it died with the process
    if (n.status === 'failed') n.status = 'pending';
    if (n.status === 'blocked') n.status = 'pending';
  }
  log(`resuming ${state.runId} (${pending.length} node(s) left)`);
  return driveRunner({ root, dir, state, graph, flags });
}

async function driveRunner({ root, dir, state, graph, flags }) {
  const runner = new Runner({
    repoRoot: root,
    runDir: dir,
    state,
    graph,
    guard: new Guard({}),
    opts: {
      budgetMin: flags['budget-min'] ? Number(flags['budget-min']) : null,
      maxRuns: flags['max-nodes'] ? Number(flags['max-nodes']) : null,
      failFast: Boolean(flags['fail-fast']),
      stallMs: 3 * 60_000,
    },
    log,
  });

  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals === 1) {
      log(C.yellow('stop requested — finishing running nodes (Ctrl-C again to abort)'));
      runner.stop('signal');
    } else {
      for (const { promise } of runner.inflight.values()) promise?.catch?.(() => {});
      process.exit(130);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const result = await runner.run();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  printStatus(state, graph);
  const { counts } = result;
  const line = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
  console.log(C.bold(`\n${line}`));
  console.log(C.dim(`logs: ${path.relative(root, path.join(dir, 'logs'))}`));
  return result.complete ? 0 : 1;
}

// ---------------------------------------------------------------- status / logs

function printStatus(state, graph) {
  const nodes = graph.nodes;
  const w = Math.max(4, ...nodes.map((n) => n.id.length));
  for (const n of nodes) {
    const s = state.nodes[n.id] ?? {};
    const icon = { done: C.green('✔'), failed: C.red('✖'), blocked: C.yellow('⊘'), running: C.cyan('▶'), pending: C.dim('·') }[s.status] ?? ' ';
    const dur = s.startedAt && s.endedAt ? `${((s.endedAt - s.startedAt) / 1000).toFixed(0)}s` : '';
    const extra = s.reason ? C.dim(` ${s.reason}`) : '';
    console.log(`  ${icon} ${n.id.padEnd(w)} ${String(s.status ?? '?').padEnd(8)} ${dur.padStart(5)}${extra}`);
  }
}

function cmdStatus({ positional, flags }) {
  const root = repoRoot();
  const dir = resolveRunDir(root, positional[0] ?? flags.run);
  if (!dir) die('no runs yet');
  const state = loadState(dir);
  const graph = loadGraph(dir);
  console.log(C.bold(`run ${state.runId}`) + C.dim(` · ${state.goal ?? ''}`));
  printStatus(state, graph);
  console.log(C.dim(`\n${path.relative(root, dir)}`));
}

function cmdLogs({ positional }) {
  const root = repoRoot();
  const [node, runId] = positional;
  if (!node) die('usage: stewie logs <node> [runId]');
  const dir = resolveRunDir(root, runId);
  if (!dir) die('no runs yet');
  const file = path.join(dir, 'logs', `${node}.log`);
  if (!fs.existsSync(file)) die(`no log for node "${node}"`);
  process.stdout.write(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------- verify / doctor

function detectChecks(root) {
  const checks = [];
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      /* ignore */
    }
    const scripts = pkg.scripts ?? {};
    const pm = fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm';
    for (const name of ['typecheck', 'lint', 'test']) {
      if (scripts[name]) checks.push(`${pm} ${name}`);
    }
  }
  if (!checks.length && fs.existsSync(path.join(root, 'pytest.ini'))) checks.push('pytest -q');
  return checks;
}

function cmdVerify({ positional, flags }) {
  const root = repoRoot();
  const cmds = positional.length ? [positional.join(' ')] : detectChecks(root);
  if (!cmds.length) die('could not detect a check command — pass one: stewie verify "<command>"');
  log(`checking: ${cmds.join(' ; ')}`);
  for (const cmd of cmds) {
    const started = Date.now();
    let ok = true;
    try {
      execFileSync('/bin/zsh', ['-lc', cmd], { cwd: root, stdio: 'inherit' });
    } catch {
      ok = false;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(ok ? C.green(`✔ ${cmd} (${secs}s)`) : C.red(`✖ ${cmd} (${secs}s)`));
    if (!ok && !flags.all) return 1;
  }
  return 0;
}

function cmdDoctor() {
  const root = repoRoot();
  const snap = systemSnapshot();
  console.log(C.bold('stewie doctor'));
  console.log(`  repo         ${root}`);
  console.log(`  machine      ${describeSystem(snap)}`);
  console.log(`  guard        ${snap.ok ? C.green('ready') : C.yellow('holding: ' + snap.reasons.join('; '))}`);
  console.log(`  concurrency  ${defaultConcurrency()} (auto)`);
  const checks = detectChecks(root);
  console.log(`  checks       ${checks.length ? checks.join(' ; ') : C.dim('none detected')}`);
  try {
    const v = execFileSync(process.env.STEWIE_OPENCODE_BIN ?? 'opencode', ['--version'], { encoding: 'utf8' }).trim();
    console.log(`  opencode     ${v}`);
  } catch {
    console.log(`  opencode     ${C.red('not found on PATH')}`);
  }
  const runs = path.join(root, '.stewie', 'runs');
  if (fs.existsSync(runs)) console.log(`  runs         ${fs.readdirSync(runs).length}`);
}

// ---------------------------------------------------------------- serve

async function cmdServe({ flags }) {
  const root = repoRoot();
  const port = Number(flags.port ?? 4321);
  const lan = Boolean(flags.lan);
  const tv = Boolean(flags.tv);
  const srv = await startServer({
    repoRoot: root,
    port,
    host: lan ? '0.0.0.0' : '127.0.0.1',
    open: flags['no-open'] ? false : true,
    openPath: tv ? '/?tv=1' : '/',
    log: (m) => console.log(C.bold(m)),
  });
  if (tv) console.log(C.dim('tv mode: big type, no input box — point the TV at this URL'));
  if (lan) console.log(C.yellow('lan mode: reachable from other devices on your network'));
  console.log(C.dim(`repo ${root}`));
  console.log(C.dim('Ctrl-C stops the dashboard (run state is kept on disk)'));
  const shutdown = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {});
}

// ---------------------------------------------------------------- main

const HELP = `${C.bold('stewie')} — bounded task-graph runner for OpenCode

${C.bold('usage')}
  stewie init [--goal "…"]              create .stewie/graph.json
  stewie plan "<goal>"                  ask a planner agent to build the graph
  stewie run [graph.json] [flags]       execute the graph
  stewie resume [runId]                 continue an interrupted run
  stewie status [runId]                 show node states
  stewie logs <node> [runId]            print a node's log
  stewie graph [graph.json]             show the dependency graph
  stewie verify [command]               run repo checks once
  stewie doctor                         machine + repo readiness
  stewie serve [--port 4321] [--lan] [--tv]
                                        open the dashboard (--tv = big screen mode)

${C.bold('run flags')}
  --concurrency N   parallel workers (default: ${defaultConcurrency()} on this machine)
  --model M         model for agent nodes (default: your OpenCode config)
  --agent A         agent for nodes (default: build)
  --budget-min N    stop scheduling after N minutes
  --max-nodes N     stop after N node executions
  --fail-fast       stop scheduling once a node fails
  --dry-run         print the plan, execute nothing
  --force           start even if the machine is busy
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'init':
      return cmdInit(rest) ?? 0;
    case 'graph':
      return cmdGraph(rest) ?? 0;
    case 'plan':
      return cmdPlan(rest) ?? 0;
    case 'run':
      return cmdRun(rest);
    case 'resume':
      return cmdResume(rest);
    case 'status':
      return cmdStatus(rest) ?? 0;
    case 'logs':
      return cmdLogs(rest) ?? 0;
    case 'verify':
      return cmdVerify(rest) ?? 0;
    case 'doctor':
      return cmdDoctor() ?? 0;
    case 'serve':
    case 'dashboard':
      return cmdServe(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      die(`unknown command "${cmd}" (try: stewie help)`);
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(C.red(`stewie crashed: ${err?.stack ?? err}`));
    process.exit(1);
  });
