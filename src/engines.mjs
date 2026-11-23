// One interface for the coding agents already installed on the machine.
//
// A node runs on whichever CLI the graph names: opencode (the default), codex,
// claude or grok. Each engine is non-interactive and auto-approving, because a
// node has no one at the keyboard; the runner's own guard and the graph's ask
// gates are the safety boundary, not the engine's prompts.
//
// Every command can be overridden for a machine where the binary lives somewhere
// unusual: STEWIE_OPENCODE_BIN, STEWIE_CODEX_BIN, STEWIE_CLAUDE_BIN, STEWIE_GROK_BIN.

export const ENGINES = ['opencode', 'codex', 'claude', 'grok'];

const DEFAULT_BIN = {
  opencode: 'opencode',
  codex: 'codex',
  claude: 'claude',
  grok: 'grok',
};

export function engineBinary(engine) {
  const key = `STEWIE_${String(engine).toUpperCase()}_BIN`;
  return process.env[key] ?? DEFAULT_BIN[engine] ?? engine;
}

/** The engine for a node: its own, then the graph's, then the environment, then opencode. */
export function engineFor(node = {}, graph = {}) {
  const named = node.engine ?? graph.engine ?? process.env.STEWIE_ENGINE ?? 'opencode';
  return String(named).toLowerCase();
}

/**
 * The exact argv for one agent node. `extra` is a graph's escape hatch for flags
 * this table does not know (`engineArgs`); it is appended before the prompt.
 */
export function buildAgentCommand({ engine, prompt, model = null, agent = null, extra = [] } = {}) {
  const name = String(engine ?? 'opencode').toLowerCase();
  const bin = engineBinary(name);
  const args = [];

  switch (name) {
    case 'opencode': {
      args.push('run', '--agent', agent || 'build', '--auto');
      if (model) args.push('--model', model);
      args.push(...extra, prompt);
      break;
    }
    case 'codex': {
      // workspace-write keeps writes inside the repo; approve-for-me is the
      // non-interactive equivalent of saying yes to the tool prompts.
      args.push('exec', '--sandbox', 'workspace-write', '--approve-for-me');
      if (model) args.push('--model', model);
      args.push(...extra, prompt);
      break;
    }
    case 'claude': {
      args.push('--print', '--dangerously-skip-permissions');
      if (model) args.push('--model', model);
      if (agent && agent !== 'build') args.push('--agent', agent);
      args.push(...extra, prompt);
      break;
    }
    case 'grok': {
      args.push('--single', '--always-approve');
      if (model) args.push('--model', model);
      if (agent && agent !== 'build') args.push('--agent', agent);
      args.push(...extra, prompt);
      break;
    }
    default:
      throw new Error(`unknown engine "${name}" (use one of: ${ENGINES.join(', ')})`);
  }

  return { command: bin, args, engine: name };
}
