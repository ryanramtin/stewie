// Search across one repo's stewie folder: runs, nodes, inbox items and log lines.
//
// Everything is already on disk, so this is a bounded scan rather than an index:
// newest runs first, logs read from the tail and capped, results cut at a limit.
// The point is to answer "where did I see that" in under a second without adding
// a database nobody will back up.

import fs from 'node:fs';
import path from 'node:path';
import { runsDir } from './state.mjs';
import { listRepo } from './inbox.mjs';

const MAX_RUNS = 40;
const MAX_LOG_BYTES = 96 * 1024;
const MAX_LOG_HITS = 8;

function safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function tail(file, maxBytes) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/** The line around a hit, trimmed, so a result is readable on one row. */
function hitLine(text, needle) {
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return null;
  const from = text.lastIndexOf('\n', index) + 1;
  const to = text.indexOf('\n', index);
  const line = text.slice(from, to === -1 ? text.length : to).trim();
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}

export function searchRepo(repoRoot, query, { limit = 40 } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle.length < 2) return { query: '', results: [] };

  const results = [];
  const says = (text) => String(text ?? '').toLowerCase().includes(needle);

  // Runs and nodes, newest first.
  const dir = runsDir(repoRoot);
  let runs = [];
  if (fs.existsSync(dir)) {
    runs = fs
      .readdirSync(dir)
      .filter((id) => fs.existsSync(path.join(dir, id, 'state.json')))
      .sort()
      .reverse()
      .slice(0, MAX_RUNS);
  }

  for (const runId of runs) {
    const runDir = path.join(dir, runId);
    const state = safeJson(path.join(runDir, 'state.json'));
    if (!state) continue;
    const goal = String(state.goal ?? '');

    if (says(goal) || says(runId)) {
      results.push({
        kind: 'run',
        runId,
        title: goal || runId,
        detail: `${runId} · ${Object.keys(state.nodes ?? {}).length} nodes`,
      });
    }

    for (const [nodeId, node] of Object.entries(state.nodes ?? {})) {
      const reason = String(node.reason ?? '');
      if (says(nodeId) || says(reason)) {
        results.push({
          kind: 'node',
          runId,
          nodeId,
          title: `${nodeId} · ${node.status}`,
          detail: reason || `${runId} · ${node.status}`,
        });
      }
    }

    if (results.length >= limit) break;

    // Logs last, and only from the tail of the file.
    let logHits = 0;
    for (const nodeId of Object.keys(state.nodes ?? {})) {
      if (logHits >= MAX_LOG_HITS || results.length >= limit) break;
      const file = path.join(runDir, 'logs', `${nodeId}.log`);
      if (!fs.existsSync(file)) continue;
      const text = tail(file, MAX_LOG_BYTES);
      if (!text) continue;
      const line = hitLine(text, needle);
      if (!line) continue;
      logHits += 1;
      results.push({ kind: 'log', runId, nodeId, title: line, detail: `${nodeId} · ${runId}` });
    }
    if (results.length >= limit) break;
  }

  // Inbox: questions, notes and answers.
  for (const item of listRepo(repoRoot, { limit: 200 })) {
    if (results.length >= limit) break;
    const answer = item.answer ? `${item.answer.choice ?? ''} ${item.answer.note ?? ''}` : '';
    if (says(item.title) || says(item.detail) || says(answer)) {
      results.push({
        kind: 'inbox',
        itemId: item.id,
        title: item.title,
        detail: `${item.kind} · ${item.status}${item.node ? ` · ${item.node}` : ''}`,
      });
    }
  }

  return { query: String(query).trim(), results: results.slice(0, limit) };
}
