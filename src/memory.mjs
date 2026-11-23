// Memory: what stewie learned in this repo, kept after the run that learned it.
//
// A run used to end with nothing but a state file, so the next run started as
// blind as the first one: the same dead end, the same broken command, the same
// "the test command is actually pnpm test". This keeps three things on disk and
// feeds them back into every node prompt:
//
//   .stewie/memory/MEMORY.md    short, curated facts and lessons. A person or a
//                              node writes these; they are always included.
//   .stewie/memory/notes.jsonl  one line per finished node: what it was asked,
//                              what it touched, what failed. Cheap, automatic.
//   .stewie/memory/index.json  not a file — derived at read time. Notes are
//                              scored against the task at hand, newest weighted
//                              highest, so a long history never crowds the prompt.
//
// Local only: `.stewie/` is gitignored, so nothing here leaves the machine and
// nothing here can be committed by accident. Every write is scrubbed first.

import fs from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from './redact.mjs';

const KEEP_NOTES = 300;
const MAX_BYTES = 512 * 1024;
const PROMPT_CHARS = 2000;
const CURATED_CHARS = 900;
const RECENT_FALLBACK = 3;
const HALF_LIFE_DAYS = 10;

const CURATED_TEMPLATE = `# Memory

<!--
  What every node reads before it starts. Keep it short and true: a command that
  works, a file that matters, a decision already made. Add a line with:
    stewie memory add "the test command is pnpm test"
-->

## Facts

## Lessons
`;

const STOPWORDS = new Set(
  `a an and are as at be been but by can could do does for from had has have how i if in into is it its just like make makes may me might more most must my no not of on only or other our out over should so some such than that the their them then there these they this to too under up us use used using very was we were what when where which while who why will with without would you your repo repos file files code change changes update add fix run make sure please also still new old way ways thing things`
    .split(/\s+/)
    .filter(Boolean),
);

export function memoryDir(repoRoot) {
  return path.join(repoRoot, '.stewie', 'memory');
}

export function curatedPath(repoRoot) {
  return path.join(memoryDir(repoRoot), 'MEMORY.md');
}

export function notesPath(repoRoot) {
  return path.join(memoryDir(repoRoot), 'notes.jsonl');
}

/** Make the memory folder exist. Never throws: memory is a convenience, not a gate. */
export function ensureMemory(repoRoot) {
  const dir = memoryDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(curatedPath(repoRoot))) fs.writeFileSync(curatedPath(repoRoot), CURATED_TEMPLATE);
  return dir;
}

// ---------------------------------------------------------------- curated

export function readCurated(repoRoot) {
  try {
    return fs.readFileSync(curatedPath(repoRoot), 'utf8');
  } catch {
    return '';
  }
}

export function writeCurated(repoRoot, text) {
  ensureMemory(repoRoot);
  fs.writeFileSync(curatedPath(repoRoot), text.endsWith('\n') ? text : text + '\n');
}

/** The curated body without the header comment block, empty sections, or the title. */
export function curatedBody(repoRoot) {
  const raw = readCurated(repoRoot).replace(/<!--[\s\S]*?-->/g, '');
  const sections = [];
  let current = null;
  const flush = () => {
    if (current?.items.length) sections.push(`${current.heading}\n${current.items.join('\n')}`);
    current = null;
  };
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      flush();
      // The `# Memory` title is scaffolding; deeper headings are kept.
      current = { heading: heading[1].length > 1 ? `## ${heading[2]}` : '', items: [] };
      continue;
    }
    if (!current) current = { heading: '', items: [] };
    current.items.push(line.trimEnd());
  }
  flush();
  return sections.join('\n\n').trim();
}

/** Add one line under `## Facts` (or `## Lessons`). */
export function addFact(repoRoot, fact, { section = 'Facts', now = Date.now() } = {}) {
  const line = scrubSecrets(String(fact).replace(/\s+/g, ' ').trim());
  if (!line) return null;
  let text = readCurated(repoRoot);
  if (!text.trim()) text = CURATED_TEMPLATE;
  const entry = line.startsWith('-') ? line : `- ${line}`;
  const heading = `## ${section}`;

  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at === -1) {
    lines.push('', heading, entry);
  } else {
    // Insert after the last non-empty line that belongs to this section, so the
    // list stays in the order it was written and keeps its blank line.
    let insert = at + 1;
    if (lines[insert] !== undefined && lines[insert].trim() === '') insert += 1;
    for (let i = insert; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break;
      if (lines[i].trim()) insert = i + 1;
    }
    lines.splice(insert, 0, entry);
  }
  // One blank line before every heading, never two anywhere.
  const cleaned = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+(?=#{1,6}\s)/g, '\n\n');
  writeCurated(repoRoot, cleaned.trimEnd());
  return { line: entry, section, at: new Date(now).toISOString() };
}

// ---------------------------------------------------------------- notes

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Like clip, but keeps the line breaks that make a written list readable. */
function clipBlock(text, max) {
  const s = String(text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastBreak = cut.lastIndexOf('\n');
  return `${(lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`;
}

/** `git diff --numstat` text → [{ path, add, del }] */
export function parseNumstat(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 3 && parts[2])
    .map(([add, del, file]) => ({
      path: file.trim(),
      add: Number(add) || 0,
      del: Number(del) || 0,
    }))
    .filter((f) => f.path && !f.path.startsWith('.stewie/'))
    .slice(0, 24);
}

/**
 * Remember one finished node. Called by the runner after the node reaches a
 * terminal state, so a retry that later passes is not remembered as a failure.
 */
export function rememberNode(repoRoot, { runId, node, state, result, files = [], summary = '', now = Date.now() } = {}) {
  if (!node?.id) return null;
  const record = {
    v: 1,
    at: new Date(now).toISOString(),
    runId: runId ?? null,
    node: node.id,
    kind: node.kind ?? 'agent',
    task: clip(node.task || node.command, 240),
    status: state?.status ?? 'done',
    reason: state?.reason ? clip(state.reason, 160) : null,
    skipped: result?.skipped ? clip(result.skipped, 60) : null,
    seconds: state?.startedAt && state?.endedAt ? Math.round((state.endedAt - state.startedAt) / 1000) : null,
    verify: (result?.verify ?? []).map((v) => ({ command: clip(v.command, 100), ok: v.code === 0 })).slice(0, 6),
    files: files.slice(0, 12),
    summary: clip(summary, 700),
  };

  try {
    ensureMemory(repoRoot);
    const line = scrubSecrets(JSON.stringify(record)) + '\n';
    fs.appendFileSync(notesPath(repoRoot), line);
    compactIfBig(repoRoot);
    return record;
  } catch {
    // A full disk or a read-only checkout must never fail a node that passed.
    return null;
  }
}

export function readNotes(repoRoot) {
  let raw = '';
  try {
    raw = fs.readFileSync(notesPath(repoRoot), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const note = JSON.parse(line);
      if (note && typeof note === 'object' && note.node) out.push(note);
    } catch {
      /* a half-written line at the tail is not worth losing the file over */
    }
  }
  return out;
}

/** Keep the newest KEEP_NOTES and drop the rest. Returns how many were removed. */
export function pruneNotes(repoRoot, { keep = KEEP_NOTES } = {}) {
  const notes = readNotes(repoRoot);
  if (notes.length <= keep) return 0;
  const kept = notes.slice(-keep);
  ensureMemory(repoRoot);
  fs.writeFileSync(notesPath(repoRoot), kept.map((n) => JSON.stringify(n)).join('\n') + '\n');
  return notes.length - kept.length;
}

function compactIfBig(repoRoot) {
  try {
    const { size } = fs.statSync(notesPath(repoRoot));
    if (size > MAX_BYTES) pruneNotes(repoRoot);
  } catch {
    /* nothing to compact */
  }
}

// ---------------------------------------------------------------- recall

function terms(text) {
  return [...new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
  )];
}

function noteText(note) {
  return [
    note.task,
    note.summary,
    note.reason,
    ...(note.files ?? []).map((f) => f.path),
    ...(note.verify ?? []).map((v) => v.command),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function ageDays(note, now) {
  const t = Date.parse(note.at ?? '');
  if (!Number.isFinite(t)) return 999;
  return Math.max(0, (now - t) / 86_400_000);
}

/** One note per node id (the latest), scored against the task at hand. */
export function relevantNotes(repoRoot, { task = '', goal = '', limit = 5, now = Date.now() } = {}) {
  const wanted = terms(`${task} ${goal}`);
  const latest = new Map();
  for (const note of readNotes(repoRoot)) latest.set(note.node, note); // file order: newest last

  const scored = [...latest.values()].map((note) => {
    const haystack = noteText(note);
    const hits = wanted.filter((w) => haystack.includes(w)).length;
    const recency = Math.pow(0.5, ageDays(note, now) / HALF_LIFE_DAYS);
    // A failure is the cheapest thing to learn from, so it scores a little higher.
    const penalty = note.status === 'failed' ? 0.6 : 0;
    return { note, hits, score: hits * 2 + recency + penalty };
  });

  const related = scored
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.note);

  if (related.length >= 2) return related;

  const recent = scored
    .sort((a, b) => Date.parse(b.note.at ?? 0) - Date.parse(a.note.at ?? 0))
    .slice(0, limit)
    .map((s) => s.note);

  const seen = new Set(related.map((n) => n.node));
  for (const note of recent) {
    if (related.length >= Math.min(limit, RECENT_FALLBACK)) break;
    if (seen.has(note.node)) continue;
    related.push(note);
    seen.add(note.node);
  }
  return related;
}

function describeNote(note, now) {
  const when = new Date(note.at ?? Date.now()).toISOString().slice(0, 10);
  const who = note.runId ? `run ${note.runId} · ` : '';
  const status = note.skipped ? `skipped (${note.skipped})` : note.status;
  const reason = note.reason ? ` — ${note.reason}` : '';
  const files = (note.files ?? []).slice(0, 4).map((f) => `${f.path}(+${f.add}/-${f.del})`).join(', ');
  const verify = (note.verify ?? []).map((v) => `${v.ok ? 'ok' : 'FAILED'} ${v.command}`).join('; ');
  const bits = [
    `${when} · ${who}node ${note.node} · ${status}${reason}`,
    files ? `files: ${files}` : '',
    verify ? `checks: ${verify}` : '',
    note.summary ? `said: ${note.summary}` : '',
  ].filter(Boolean);
  return `- ${bits.join(' · ')}`;
}

/**
 * The block a node (or the planner) gets before it starts. Empty string when
 * there is nothing to remember yet, so a fresh repo's prompt is unchanged.
 */
export function memoryPrompt(repoRoot, { task = '', goal = '', limit = 5, now = Date.now() } = {}) {
  const curated = clipBlock(curatedBody(repoRoot), CURATED_CHARS);
  const notes = relevantNotes(repoRoot, { task, goal, limit, now });
  if (!curated && !notes.length) return '';

  const parts = [];
  if (curated) parts.push(`WRITTEN DOWN ABOUT THIS REPO:\n${curated}`);
  if (notes.length) parts.push(`EARLIER NODES (most relevant first):\n${notes.map((n) => describeNote(n, now)).join('\n')}`);

  const block = parts.join('\n\n');
  return block.length > PROMPT_CHARS ? `${block.slice(0, PROMPT_CHARS - 1)}…` : block;
}

export function memoryStats(repoRoot, { now = Date.now() } = {}) {
  const notes = readNotes(repoRoot);
  const latest = new Map();
  for (const note of notes) latest.set(note.node, note);
  const files = new Set();
  for (const note of notes) for (const f of note.files ?? []) files.add(f.path);
  const curated = curatedBody(repoRoot);
  return {
    dir: memoryDir(repoRoot),
    curatedLines: curated ? curated.split('\n').filter((l) => l.trim()).length : 0,
    notes: notes.length,
    nodes: latest.size,
    failed: notes.filter((n) => n.status === 'failed').length,
    files: files.size,
    last: notes.length ? notes[notes.length - 1].at : null,
    ageDays: notes.length ? Math.round(ageDays(notes[notes.length - 1], now)) : null,
  };
}
