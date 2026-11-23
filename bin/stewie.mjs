#!/usr/bin/env node
// stewie — bounded task-graph runner for OpenCode.
// Parity behaviours: plan mode, durable runs, parallel workers, verify gates,
// hard concurrency limits, and a system guard that refuses to swap the machine.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { validateGraph, renderGraph } from '../src/graph.mjs';
import { Guard, defaultConcurrency, systemSnapshot, describeSystem } from '../src/guard.mjs';
import { createRun, resolveRunDir, loadState, loadGraph } from '../src/state.mjs';
import { Runner } from '../src/runner.mjs';
import { startServer } from '../src/server.mjs';
import { askRepo, answerRepo, listRepo, waitForAnswer, expireStale, isRefusal } from '../src/inbox.mjs';
import { parseExport, planImport, writeImport, describePlan, ImportError, IMPORT_PROMPT } from '../src/import.mjs';
import { memoryDir, memoryPrompt, memoryStats, readCurated, addFact, pruneNotes, ensureMemory } from '../src/memory.mjs';

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

  // Memory starts here: a file a person can edit and every node reads.
  ensureMemory(root);

  console.log(`created ${path.relative(root, file)}`);
  console.log(C.dim(`memory: ${path.relative(root, path.join(memoryDir(root), 'MEMORY.md'))} (kept across runs, local only)`));
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

  const remembered = memoryPrompt(root, { task: goal, goal });

  const prompt = [
    'Create an execution graph for this coding goal, as JSON only.',
    `GOAL: ${goal}`,
    remembered ? `WHAT EARLIER RUNS IN THIS REPO LEARNED (do not plan a dead end it already hit):\n${remembered}` : '',
    [
      'Respond with a single JSON object and nothing else, in this shape:',
      `{"goal":"...","nodes":[{"id":"short-id","task":"what this worker must do","deps":[],"verify":["command"]}]}`,
      '',
      'Rules:',
      '- 2 to 6 nodes, ids are short kebab-case, dependencies only reference earlier ids.',
      '- Node 1 always explores and reports the repo (test commands, risky areas).',
      '- The last node is a shell node that runs the real check command(s).',
      '- Verification commands must be real commands that will work in this repo.',
      '- Keep independent nodes parallel-friendly (they run concurrently).',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');

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
    guard: new Guard(flags.force ? { minFreeBytes: 0, maxLoad: Number.POSITIVE_INFINITY } : {}),
    opts: {
      budgetMin: flags['budget-min'] ? Number(flags['budget-min']) : null,
      maxRuns: flags['max-nodes'] ? Number(flags['max-nodes']) : null,
      failFast: Boolean(flags['fail-fast']),
      stallMs: 3 * 60_000,
      memory: !flags['no-memory'],
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
  const mem = memoryStats(root);
  const written = mem.curatedLines ? `${mem.curatedLines} written line(s)` : '';
  const learned = mem.notes ? `${mem.notes} note(s) from ${mem.nodes} node(s), ${mem.files} file(s), last ${mem.ageDays}d ago` : '';
  console.log(`  memory       ${[written, learned].filter(Boolean).join(' · ') || C.dim('nothing yet — the first run starts it')}`);
}

// ---------------------------------------------------------------- memory

function cmdMemory({ positional, flags }) {
  const root = repoRoot();
  const sub = positional[0];
  const words = positional.slice(1).join(' ').trim();

  if (sub === 'add') {
    if (!words) die('usage: stewie memory add "<one line>" [--lesson]');
    const added = addFact(root, words, { section: flags.lesson ? 'Lessons' : 'Facts' });
    console.log(C.green('remembered') + ` (${added.section.toLowerCase()}): ${added.line}`);
    console.log(C.dim(`  ${path.relative(root, path.join(memoryDir(root), 'MEMORY.md'))}`));
    return 0;
  }

  if (sub === 'forget') {
    if (flags.all) {
      const removed = pruneNotes(root, { keep: 0 });
      console.log(C.green('cleared') + ` ${removed} remembered node(s) — MEMORY.md is untouched`);
      return 0;
    }
    const removed = pruneNotes(root, { keep: Number(flags.keep ?? 100) });
    console.log(removed ? C.green('trimmed') + ` ${removed} old note(s)` : C.dim('nothing to trim'));
    return 0;
  }

  if (sub === 'path') {
    console.log(memoryDir(root));
    return 0;
  }

  const stats = memoryStats(root);
  const curated = readCurated(root).trim();
  const preview = memoryPrompt(root, { task: String(flags.task ?? ''), goal: String(flags.task ?? '') });

  console.log(C.bold('stewie memory') + C.dim(` · ${path.relative(root, stats.dir)}`));
  console.log(
    C.dim(
      `  ${stats.notes} note(s) · ${stats.nodes} node(s) · ${stats.failed} failure(s) · ${stats.files} file(s)` +
        (stats.last ? ` · last ${stats.ageDays}d ago` : ' · empty'),
    ),
  );
  console.log('');
  console.log(curated || C.dim('MEMORY.md is empty — write one with: stewie memory add "<fact>"'));
  console.log('');
  console.log(C.bold(flags.task ? `what a node would see for "${flags.task}"` : 'what every node sees'));
  console.log(preview ? indent(preview, '  ') : C.dim('  nothing yet — the first run starts it'));
  return 0;
}

// ---------------------------------------------------------------- inbox

async function cmdAsk({ positional, flags }) {
  const root = repoRoot();
  const title = positional.join(' ').trim();
  if (!title) die('usage: stewie ask "<question>" [--detail "…"] [--options allow,skip] [--timeout 30]');
  const options = String(flags.options ?? 'allow,skip')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const timeoutMin = flags.timeout == null ? 30 : Number(flags.timeout);
  const item = askRepo(root, {
    kind: 'question',
    title,
    detail: typeof flags.detail === 'string' ? flags.detail : '',
    options,
    askedBy: flags.by ?? process.env.STEWIE_NODE ?? 'cli',
    node: process.env.STEWIE_NODE ?? null,
    runId: process.env.STEWIE_RUN ?? null,
    timeoutMs: timeoutMin > 0 ? timeoutMin * 60_000 : null,
  });

  console.log(C.bold('✋ ' + item.title));
  if (item.detail) console.log(C.dim(indent(item.detail, '   ')));
  console.log(C.dim(`   inbox id ${item.id} — also waiting in the dashboard${timeoutMin > 0 ? `, ${timeoutMin} min` : ''}`));

  let answer = null;
  if (process.stdin.isTTY && options.length) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const label = options.map((o, i) => `${i + 1}) ${o}`).join('   ');
    const reply = await new Promise((resolve) => rl.question(`   ${label}   > `, resolve));
    rl.close();
    const picked = options[Number(reply.trim()) - 1] ?? (reply.trim() || options[0]);
    answer = answerRepo(root, item.id, { choice: picked, by: 'terminal' });
    console.log(C.green(`   → ${picked}`));
  } else {
    console.log(C.dim('   waiting… answer in the stewie dashboard, or run `stewie answer ' + item.id + ' <choice>`'));
    const waited = await waitForAnswer(root, item.id, { timeoutMs: timeoutMin > 0 ? timeoutMin * 60_000 : 0 });
    if (waited.status === 'answered') {
      answer = waited.item;
      console.log(C.green(`   → ${waited.answer.choice || '(no choice)'}${waited.answer.note ? ` — ${waited.answer.note}` : ''}`));
    } else {
      console.log(C.red(`   → ${waited.status}`));
      return 4;
    }
  }

  const choice = answer?.answer?.choice ?? '';
  if (isRefusal(choice)) return 3;
  return choice ? 0 : 4;
}

function cmdInbox({ flags }) {
  const root = repoRoot();
  expireStale(root);
  const all = listRepo(root, { limit: 80 });
  const open = all.filter((i) => i.status === 'open');
  const recent = all.filter((i) => i.status !== 'open').slice(0, 12);

  if (!open.length && !flags.all) console.log(C.dim('inbox empty — nothing is waiting on you'));
  for (const item of open) {
    const mark = item.kind === 'note' ? C.cyan('•') : C.yellow('?');
    const who = [item.askedBy, item.node].filter(Boolean).join(' · ');
    console.log(`${mark} ${C.bold(item.title)}`);
    console.log(C.dim(`   ${item.id} · ${who} · ${ago(item.createdAt)}`));
    if (item.detail) console.log(C.dim(indent(item.detail.split('\n').slice(0, 4).join('\n'), '   ')));
    if (item.options.length) console.log(C.dim(`   options: ${item.options.join(' | ')}   → stewie answer ${item.id} <choice>`));
  }
  if (flags.all && recent.length) {
    console.log(C.dim('\nrecent'));
    for (const item of recent) {
      console.log(C.dim(`   ${item.answer?.choice ?? item.status} · ${item.title.slice(0, 80)} · ${ago(item.createdAt)}`));
    }
  }
  return 0;
}

function cmdAnswer({ positional, flags }) {
  const root = repoRoot();
  const [id, ...words] = positional;
  if (!id) die('usage: stewie answer <inbox-id> <choice or words>');
  const item = answerRepo(root, id, { choice: words.join(' ').trim() || String(flags.choice ?? 'allow'), note: String(flags.note ?? ''), by: 'terminal' });
  if (!item) die(`no inbox item ${id}`);
  console.log(`answered ${id}: ${item.answer?.choice ?? item.status}`);
  return 0;
}

function indent(text, pad) {
  return text.split('\n').map((l) => pad + l).join('\n');
}

function ago(at) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------------------------------------------------------------- import

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

const IMPORT_REASONS = {
  notExport: 'that text is not an export — it needs the JSON document the old bot wrote',
  cutOff: 'the document stops in the middle (unbalanced braces) — ask the bot for the rest and import every part',
  tooLarge: `the document is over 4MB — import it in parts`,
  newerVersion: 'that export is a newer format than this stewie understands',
  credentials: 'the document carries credentials — it is refused whole, so nothing leaks. Take those keys out and try again',
};

async function cmdImport({ positional, flags }) {
  const root = repoRoot();
  if (flags.prompt) {
    console.log(IMPORT_PROMPT);
    return 0;
  }

  let text = '';
  if (flags.paste) text = await readStdin();
  else if (positional[0]) {
    const file = path.resolve(root, positional[0]);
    if (!fs.existsSync(file)) die(`no file at ${positional[0]}`);
    text = fs.readFileSync(file, 'utf8');
  } else {
    console.log(C.bold('stewie import') + ' — move a Grok Bot across');
    console.log('');
    console.log('  1. stewie import --prompt        copy that prompt into the old bot');
    console.log('  2. it replies with one JSON document: save it, or copy the whole reply');
    console.log('  3. stewie import <file>          or: pbpaste | stewie import --paste');
    console.log('');
    console.log(C.dim('nothing is sent anywhere; the import is local files only'));
    return 0;
  }

  let bots;
  try {
    bots = parseExport(text);
  } catch (err) {
    if (err instanceof ImportError) {
      console.error(C.red(`stewie: ${IMPORT_REASONS[err.code] ?? err.code}`));
      if (err.keys?.length) console.error(C.dim(`  credential-looking keys: ${err.keys.join(', ')}`));
      return 1;
    }
    throw err;
  }

  const plan = planImport(bots);
  const report = describePlan(plan, { written: [], skipped: [] });

  if (flags['dry-run']) {
    console.log(C.bold('would import'));
    console.log(report);
    for (const item of plan) {
      if (item.memoryText) console.log(C.dim(`  .stewie/imports/${item.folder}/MEMORY.md`));
      if (item.migrationText) console.log(C.dim(`  .stewie/imports/${item.folder}/MIGRATION.md`));
      for (const s of item.skills) console.log(C.dim(`  .stewie/imports/${item.folder}/${s.file}`));
      for (const g of item.graphs) console.log(C.dim(`  ${g.file}`));
    }
    return 0;
  }

  const { written, skipped } = writeImport(root, plan, { force: Boolean(flags.force) });
  console.log(C.green('imported') + ' ' + bots.map((b) => b.name).join(', '));
  console.log(describePlan(plan, { written, skipped }));

  const graphs = plan.flatMap((item) => item.graphs.map((g) => g.file));
  if (graphs.length) {
    console.log('');
    console.log(C.dim('run one: ') + `stewie run ${graphs[0]}`);
  }
  const needed = plan.filter((item) => item.migrationText);
  if (needed.length) console.log(C.dim(`read: .stewie/imports/${needed[0].folder}/MIGRATION.md`));

  // The result goes to the inbox too: an import is exactly the kind of thing a
  // person should see once, with the parts that still need them.
  try {
    askRepo(root, {
      kind: 'note',
      title: `Imported ${bots.map((b) => b.name).join(', ')} from the old assistant`,
      detail: `${report}${needed.length ? '\n\nWhat needs you:' : ''}${needed.map((i) => `\n- .stewie/imports/${i.folder}/MIGRATION.md`).join('')}`,
      askedBy: 'stewie import',
    });
  } catch {
    /* the inbox is never a reason to fail an import */
  }
  return 0;
}

// ---------------------------------------------------------------- serve

function randomToken() {
  return crypto.randomBytes(18).toString('hex');
}

async function cmdServe({ flags }) {
  const root = repoRoot();
  const port = Number(flags.port ?? 4321);
  const lan = Boolean(flags.lan);
  const tv = Boolean(flags.tv);
  const token = lan ? (flags.token ?? randomToken()) : null;
  const srv = await startServer({
    repoRoot: root,
    port,
    host: lan ? '0.0.0.0' : '127.0.0.1',
    open: flags['no-open'] ? false : true,
    openPath: tv ? '/?tv=1' : '/',
    token,
    log: (m) => console.log(C.bold(m)),
  });
  if (tv) console.log(C.dim('tv mode: big type, no input box — point the TV at this URL'));
  if (lan) {
    console.log(C.yellow('lan mode: reachable from other devices, token required'));
    console.log(C.dim(`tv url: ${srv.url}/?token=${token}${tv ? '&tv=1' : ''}`));
  }
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
  stewie ask "<question>" [flags]       ask a person and wait for the answer
  stewie inbox [--all]                  what is waiting on you right now
  stewie answer <id> <choice>           answer from the terminal
  stewie memory [--task "…"]            what stewie has learned about this repo
  stewie memory add "<one line>"        write a fact every node will read (--lesson)
  stewie memory forget [--all]          trim old notes (MEMORY.md is kept)
  stewie import [file] [--paste] [--prompt]
                                        move a Grok Bot's setup across
  stewie serve [--port 4321] [--lan] [--tv] [--token HEX]
                                        open the dashboard (--tv = big screen mode)

${C.bold('ask flags')}
  --detail "…"      the context behind the question
  --options a,b     the buttons (default: allow,skip)
  --timeout N       minutes to wait, 0 = forever (default: 30)

${C.bold('run flags')}
  --concurrency N   parallel workers (default: ${defaultConcurrency()} on this machine)
  --model M         model for agent nodes (default: your OpenCode config)
  --agent A         agent for nodes (default: build)
  --budget-min N    stop scheduling after N minutes
  --max-nodes N     stop after N node executions
  --fail-fast       stop scheduling once a node fails
  --dry-run         print the plan, execute nothing
  --force           start even if the machine is busy
  --no-memory       do not read (or write) what earlier runs learned
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
    case 'ask':
      return cmdAsk(rest);
    case 'inbox':
      return cmdInbox(rest) ?? 0;
    case 'memory':
      return cmdMemory(rest) ?? 0;
    case 'answer':
      return cmdAnswer(rest) ?? 0;
    case 'import':
      return cmdImport(rest);
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
