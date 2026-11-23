// Undo one node: put back the files that node touched, and nothing else.
//
// The runner snapshots the working tree before each node starts (`st.baseTree`)
// and records which paths changed (`st.writes`). Undo restores those paths from
// that snapshot; a file the node created is removed, because it did not exist.
// Files the node never touched are left alone, even if a later node changed them.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRunDir, loadState } from './state.mjs';

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function existsInTree(repoRoot, tree, file) {
  try {
    git(repoRoot, ['cat-file', '-e', `${tree}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore a node's files. Returns what happened, or throws when the node has no
 * snapshot (runs made before this existed) or the tree is not a git repo.
 */
export function undoNode(repoRoot, { runId = null, node, dryRun = false } = {}) {
  if (!node) throw new Error('usage: stewie undo <node> [runId]');
  const dir = resolveRunDir(repoRoot, runId);
  if (!dir) throw new Error('no run found');
  const state = loadState(dir);
  const st = state.nodes[node];
  if (!st) throw new Error(`run ${state.runId} has no node "${node}"`);
  if (!st.baseTree) throw new Error(`node "${node}" has no snapshot — it ran before undo existed`);
  if (!Array.isArray(st.writes) || st.writes.length === 0) {
    return { runId: state.runId, node, restored: [], removed: [], dryRun };
  }

  const restored = [];
  const removed = [];
  for (const file of [...st.writes].sort()) {
    const target = path.join(repoRoot, file);
    if (existsInTree(repoRoot, st.baseTree, file)) {
      restored.push(file);
      if (!dryRun) git(repoRoot, ['checkout', st.baseTree, '--', file]);
    } else {
      removed.push(file);
      if (!dryRun && fs.existsSync(target)) fs.unlinkSync(target);
    }
  }
  return { runId: state.runId, node, restored, removed, dryRun };
}

/** A one-line summary for the terminal and for tests. */
export function undoSummary(result) {
  const verb = result.dryRun ? 'would restore' : 'restored';
  const parts = [`${verb} ${result.restored.length} file${result.restored.length === 1 ? '' : 's'}`];
  if (result.removed.length) parts.push(`${result.dryRun ? 'would remove' : 'removed'} ${result.removed.length} created file${result.removed.length === 1 ? '' : 's'}`);
  return `${result.node}: ${parts.join(', ')}`;
}
