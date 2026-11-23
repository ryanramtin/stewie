// The inbox: the one place an agent or the runner can stop and ask a human.
//
// An item is a small JSON file in .stewie/inbox/, so the terminal CLI, the
// dashboard and a worker all see the same queue with no server in the middle.
// Questions block whoever asked; notes just sit there until they are read.
// Every answer is appended to decisions.jsonl: the log of what a machine wanted
// and what a person decided.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_RE = /^[a-z0-9-]{4,64}$/;
const MAX_ITEMS = 200;

export function inboxDir(repoRoot) {
  return path.join(repoRoot, '.stewie', 'inbox');
}

export function decisionsLog(repoRoot) {
  return path.join(inboxDir(repoRoot), 'decisions.jsonl');
}

function ensure(repoRoot) {
  const dir = inboxDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newId(at = Date.now()) {
  return `${at.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function itemPath(repoRoot, id) {
  if (!ID_RE.test(String(id))) throw new Error(`bad inbox id: ${id}`);
  return path.join(inboxDir(repoRoot), `${id}.json`);
}

function writeItem(repoRoot, item) {
  const dir = ensure(repoRoot);
  const file = path.join(dir, `${item.id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(item, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return item;
}

function readItem(repoRoot, id) {
  try {
    return JSON.parse(fs.readFileSync(itemPath(repoRoot, id), 'utf8'));
  } catch {
    return null;
  }
}

function logDecision(repoRoot, entry) {
  try {
    ensure(repoRoot);
    fs.appendFileSync(decisionsLog(repoRoot), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* the log is an audit trail, never a reason to fail an answer */
  }
}

/**
 * Open a request. `kind: 'question'` waits for a person; `kind: 'note'` only
 * reports something they should see. Options are short labels such as
 * ["allow", "deny"]; the first is the one Enter means.
 */
export function askRepo(repoRoot, { kind = 'question', title, detail = '', options = [], askedBy = 'agent', node = null, runId = null, timeoutMs = null } = {}) {
  const text = String(title ?? '').trim();
  if (!text) throw new Error('an inbox request needs a title');
  const at = Date.now();
  const item = {
    id: newId(at),
    kind: kind === 'note' ? 'note' : 'question',
    title: text.slice(0, 300),
    detail: String(detail ?? '').slice(0, 8000),
    options: (Array.isArray(options) ? options : []).map((o) => String(o).slice(0, 80)).filter(Boolean).slice(0, 6),
    askedBy: String(askedBy ?? 'agent').slice(0, 60),
    node,
    runId,
    repo: repoRoot,
    status: 'open',
    createdAt: at,
    expiresAt: timeoutMs ? at + Number(timeoutMs) : null,
    answer: null,
  };
  return writeItem(repoRoot, item);
}

/** Answer a request. Returns the updated item, or null when it is not there. */
export function answerRepo(repoRoot, id, { choice = '', note = '', by = 'you' } = {}) {
  const item = readItem(repoRoot, id);
  if (!item) return null;
  if (item.status !== 'open') return item;
  item.status = 'answered';
  item.answer = { choice: String(choice ?? '').slice(0, 400), note: String(note ?? '').slice(0, 4000), by, at: Date.now() };
  item.answeredAt = item.answer.at;
  logDecision(repoRoot, { id: item.id, what: item.title, askedBy: item.askedBy, node: item.node, runId: item.runId, choice: item.answer.choice, note: item.answer.note ? 'with note' : '' });
  return writeItem(repoRoot, item);
}

/** Mark a note read, or take a question off the queue. */
export function dismissRepo(repoRoot, id, by = 'you') {
  const item = readItem(repoRoot, id);
  if (!item) return null;
  if (item.status !== 'open') return item;
  item.status = 'dismissed';
  item.answeredAt = Date.now();
  logDecision(repoRoot, { id: item.id, what: item.title, askedBy: item.askedBy, node: item.node, runId: item.runId, choice: 'dismissed' });
  item.answer = { choice: 'dismissed', by, at: item.answeredAt };
  return writeItem(repoRoot, item);
}

/** Open questions past their deadline become expired — nobody waits forever. */
export function expireStale(repoRoot, now = Date.now()) {
  const items = listRepo(repoRoot, { limit: MAX_ITEMS });
  const expired = [];
  for (const item of items) {
    if (item.status !== 'open' || item.kind !== 'question' || !item.expiresAt || item.expiresAt > now) continue;
    item.status = 'expired';
    item.answer = { choice: 'expired', at: now };
    item.answeredAt = now;
    writeItem(repoRoot, item);
    logDecision(repoRoot, { id: item.id, what: item.title, askedBy: item.askedBy, choice: 'expired' });
    expired.push(item);
  }
  return expired;
}

export function listRepo(repoRoot, { status = null, limit = 60 } = {}) {
  const dir = inboxDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const item = readItem(repoRoot, name.slice(0, -5));
    if (!item) continue;
    if (status && item.status !== status) continue;
    items.push(item);
  }
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export function pendingCount(repoRoot) {
  return listRepo(repoRoot, { status: 'open' }).filter((i) => i.kind === 'question').length;
}

/** Wait for an answer from anywhere (dashboard, another terminal). */
export async function waitForAnswer(repoRoot, id, { timeoutMs = 0, pollMs = 700 } = {}) {
  const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
  for (;;) {
    const item = readItem(repoRoot, id);
    if (!item) return { status: 'missing' };
    if (item.status === 'answered') return { status: 'answered', answer: item.answer, item };
    if (item.status === 'dismissed') return { status: 'dismissed', item };
    if (item.status === 'expired') return { status: 'expired', item };
    if (deadline && Date.now() > deadline) {
      const expired = await expireStale(repoRoot);
      if (expired.some((e) => e.id === id)) return { status: 'expired' };
      return { status: 'timeout' };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** True when a choice reads as no: deny, skip, cancel, stop, reject. */
export function isRefusal(choice) {
  return /^(no|nope|deny|denied|skip|skip it|cancel|stop|reject|rejected|disallow)\b/i.test(String(choice ?? '').trim());
}

/**
 * True only for an explicit yes. The first option is the yes (unless it reads as a
 * refusal), or the choice opens with an approval word. A gate runs on nothing else:
 * skip, dismiss, a different option, or no answer all mean "do not run".
 */
export function isApproval(choice, options = []) {
  const text = String(choice ?? '').trim();
  if (!text) return false;
  const first = String(options[0] ?? '').trim();
  if (first && !isRefusal(first) && text.toLowerCase() === first.toLowerCase()) return true;
  return /^(allow|approve|approved|yes|y|go|ok|okay|run|proceed|continue|push|ship|send|retry|use|deploy|install)\b/i.test(text);
}
