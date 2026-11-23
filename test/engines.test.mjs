import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentCommand, engineFor, ENGINES } from '../src/engines.mjs';
import { normalizeGraph } from '../src/graph.mjs';
import { Guard } from '../src/guard.mjs';
import { createRun, loadState } from '../src/state.mjs';
import { Runner } from '../src/runner.mjs';

test('every engine produces a non-interactive, auto-approving command', () => {
  for (const engine of ENGINES) {
    const { command, args } = buildAgentCommand({ engine, prompt: 'do the thing' });
    assert.ok(command, engine);
    assert.ok(args.includes('do the thing'), `${engine} must receive the prompt`);
    assert.ok(args.some((a) => ['--auto', '--approve-for-me', '--dangerously-skip-permissions', '--always-approve'].includes(a)), `${engine} must run unattended`);
  }
});

test('opencode keeps its agent and model flags', () => {
  const { args } = buildAgentCommand({ engine: 'opencode', prompt: 'p', model: 'opencode-go/x', agent: 'build' });
  assert.deepEqual(args.slice(0, 4), ['run', '--agent', 'build', '--auto']);
  assert.ok(args.includes('--model') && args.includes('opencode-go/x'));
});

test('codex uses exec, a workspace sandbox and the model', () => {
  const { args } = buildAgentCommand({ engine: 'codex', prompt: 'p', model: 'gpt-5' });
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--sandbox') && args.includes('workspace-write'));
  assert.ok(args.includes('--model') && args.includes('gpt-5'));
  assert.equal(args.at(-1), 'p');
});

test('claude and grok switch to print mode', () => {
  const claude = buildAgentCommand({ engine: 'claude', prompt: 'p' }).args;
  assert.ok(claude.includes('--print'));
  const grok = buildAgentCommand({ engine: 'grok', prompt: 'p' }).args;
  assert.ok(grok.includes('--single'));
});

test('engineArgs are passed through before the prompt', () => {
  const { args } = buildAgentCommand({ engine: 'claude', prompt: 'PROMPT', extra: ['--add-dir', '/tmp'] });
  assert.deepEqual(args.slice(-3), ['--add-dir', '/tmp', 'PROMPT']);
});

test('an unknown engine fails loudly', () => {
  assert.throws(() => buildAgentCommand({ engine: 'vim', prompt: 'p' }), /unknown engine/);
});

test('the engine resolves from node, then graph, then the environment', () => {
  assert.equal(engineFor({ engine: 'codex' }, { engine: 'claude' }), 'codex');
  assert.equal(engineFor({}, { engine: 'claude' }), 'claude');
  assert.equal(engineFor({}, {}), 'opencode');
});

test('graphs carry engine settings through normalization', () => {
  const g = normalizeGraph({ goal: 'x', engine: 'codex', nodes: [{ id: 'a', task: 't', engine: 'grok', engineArgs: ['--add-dir', '/tmp'] }] });
  assert.equal(g.engine, 'codex');
  assert.equal(g.nodes[0].engine, 'grok');
  assert.deepEqual(g.nodes[0].engineArgs, ['--add-dir', '/tmp']);
});

test('a node actually runs through the named engine binary', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-eng-'));
  const fake = path.join(repo, 'fake-engine.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(repo, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('SUMMARY: fake engine ran\\n');\n`);
  fs.chmodSync(fake, 0o755);

  // A wrapper binary stands in for the real CLI: it records the argv it was given.
  const wrapper = path.join(repo, 'fake-claude.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const previous = process.env.STEWIE_CLAUDE_BIN;
  process.env.STEWIE_CLAUDE_BIN = wrapper;
  const graph = normalizeGraph({
    goal: 'engine test',
    nodes: [{ id: 'run', task: 'say hello', engine: 'claude' }],
  });
  const { dir, state } = createRun(repo, { graph, graphPath: 'g.json', concurrency: 1, model: null });
  const runner = new Runner({ repoRoot: repo, runDir: dir, state, graph, guard: new Guard({ minFreeBytes: 0, maxLoad: 1e9 }), opts: { pollMs: 20 }, log: () => {} });
  try {
    await runner.run();
  } finally {
    if (previous === undefined) delete process.env.STEWIE_CLAUDE_BIN;
    else process.env.STEWIE_CLAUDE_BIN = previous;
  }

  const after = loadState(dir);
  assert.equal(after.nodes.run.status, 'done', JSON.stringify(after.nodes.run));
  const argv = JSON.parse(fs.readFileSync(path.join(repo, 'argv.json'), 'utf8'));
  assert.ok(argv.includes('--print'), 'claude flags reached the binary');
  assert.ok(argv.some((a) => a.includes('YOUR NODE: run')), 'the node prompt reached the binary');
});
