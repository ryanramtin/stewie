#!/usr/bin/env node
// Seeds a fake run so you can look at the dashboard (and take screenshots)
// without spending tokens. Usage: node scripts/demo.mjs [--dir /tmp/stewie-demo]

import fs from 'node:fs';
import path from 'node:path';
import { normalizeGraph } from '../src/graph.mjs';
import { createRun, saveState } from '../src/state.mjs';

const i = process.argv.indexOf('--dir');
const dir = path.resolve(i > -1 ? process.argv[i + 1] : '/tmp/stewie-demo');
fs.mkdirSync(dir, { recursive: true });
process.chdir(dir);

const graph = normalizeGraph({
  goal: 'Add passkey re-auth to the settings screen',
  concurrency: 2,
  nodes: [
    { id: 'explore', task: 'Map the auth code and the test commands', deps: [] },
    { id: 'implement-api', task: 'Add the passkey challenge endpoint', deps: ['explore'], verify: ['pnpm typecheck'] },
    { id: 'implement-ui', task: 'Wire the settings screen to the new flow', deps: ['explore'] },
    { id: 'tests', task: 'Cover the new flow', deps: ['implement-api'], verify: ['pnpm test -- passkey'] },
    { id: 'check', kind: 'shell', command: 'pnpm typecheck && pnpm lint', deps: ['tests', 'implement-ui'] },
  ],
});

const { dir: runDir, state } = createRun(dir, { graph, graphPath: '.stewie/graph.json', concurrency: 2, model: null });
const now = Date.now();
const done = (id, mins, extra = {}) => ({
  ...state.nodes[id],
  status: 'done',
  attempts: 1,
  startedAt: now - mins * 60000,
  endedAt: now - (mins - 1) * 60000,
  exitCode: 0,
  verify: [],
  ...extra,
});

state.nodes.explore = done('explore', 7);
state.nodes['implement-api'] = done('implement-api', 5, { verify: [{ command: 'pnpm typecheck', code: 0 }] });
state.nodes['implement-ui'] = { ...state.nodes['implement-ui'], status: 'running', attempts: 1, startedAt: now - 64000 };
saveState(runDir, state);

fs.writeFileSync(
  path.join(runDir, 'diffs', 'explore.numstat'),
  '18\t2\tsrc/auth/passkey.ts\n7\t0\tsrc/auth/index.ts\n',
);
fs.writeFileSync(
  path.join(runDir, 'diffs', 'implement-api.numstat'),
  '64\t3\tsrc/auth/passkey.ts\n21\t4\tsrc/auth/challenge.ts\n12\t1\tsrc/auth/index.ts\n5\t0\tsrc/api/routes.ts\n',
);
fs.writeFileSync(
  path.join(runDir, 'logs', 'implement-ui.log'),
  [
    'Reading src/screens/Settings.tsx',
    'Reading src/auth/passkey.ts',
    'Editing src/screens/Settings.tsx',
    '+ import { startPasskeyReauth } from "../auth/passkey";',
    '+ const onReauth = async () => {',
    '+   const ok = await startPasskeyReauth();',
    '+   setState(ok ? "verified" : "cancelled");',
    '+ };',
    'Writing src/screens/Settings.tsx',
    'Running pnpm typecheck',
  ].join('\n'),
);

console.log(runDir);
