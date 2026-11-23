// Moving in: take a Grok Bot (or OpenMausBot) export and turn it into things
// stewie can actually run.
//
// The old assistant has no export button, so the flow is: paste a prompt into it,
// it writes one JSON document, and this reads that document — pasted back, saved
// to a file, or fenced in a chat reply. Nothing here needs the network.
//
// What comes over: instructions, memory, skills, and every routine with a readable
// clock as a graph you can run. What cannot come over (connected apps, routines
// that start on an event) is written down in MIGRATION.md instead of being dropped
// silently. Credentials are refused, and token-shaped text is scrubbed, because an
// export that carries keys is a leak waiting to happen.

import fs from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from './redact.mjs';

export { scrubSecrets };

export const EXPORT_FORMAT = 'grok-bot-export';
const OLD_FORMATS = new Set(['openmaus.grok/1']);
const MAX_CHARS = 4 * 1024 * 1024;
const MAX_ROUTINES = 50;
const MAX_SKILLS = 40;

/** Paste this into the old bot. It answers with one JSON document. */
export const IMPORT_PROMPT = `I'm moving to another assistant. Write one JSON document with exactly this shape and nothing else outside it (if you cannot attach a file, put it in a single json code block):

{
  "format": "${EXPORT_FORMAT}",
  "version": 1,
  "bots": [
    {
      "name": "your name",
      "title": "your label or job title, or empty",
      "description": "one or two sentences on what you do",
      "instructions": "your full role, standing rules and working style, verbatim where you can",
      "memories": ["each lasting fact about the work, one string per fact"],
      "user_facts": ["each fact about me: name, time zone, preferences — one per string"],
      "skills": [
        { "name": "skill name", "description": "when to use it", "instructions": "the COMPLETE skill text, verbatim" }
      ],
      "routines": [
        {
          "name": "routine name",
          "instruction": "the COMPLETE instruction the routine runs, verbatim",
          "trigger": "schedule | slack | github | linear | sentry | pagerduty | email | webhook | other",
          "schedule_cron": "5-field cron in the routine's time zone, e.g. 0 8 * * 1-5 (empty when not scheduled)",
          "schedule_text": "when it runs, in words",
          "timezone": "IANA zone, e.g. America/New_York",
          "paused": false,
          "skills": ["names of skills this routine uses"],
          "trigger_details": "for event triggers: channel, repository, phrase, senders"
        }
      ],
      "apps": [{ "name": "connected app or MCP server name", "mcp_url": "remote MCP URL if any" }]
    }
  ]
}

Rules: include EVERY routine (paused ones too) and EVERY skill with full text, not summaries. If you cannot read something, leave it out and say what you left out in your reply; never guess. Never include passwords, API keys, tokens, webhook keys, cookies or card numbers. Valid JSON only, no comments. If it is too long, send several documents in this same shape, each with a different part; they are imported together.
`;

export class ImportError extends Error {
  constructor(code, keys = []) {
    super(code);
    this.name = 'ImportError';
    this.code = code;
    this.keys = keys;
  }
}

const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const first = (...values) => values.map(str).find(Boolean) ?? '';
const list = (v) => (Array.isArray(v) ? v : []);

function strings(v) {
  return list(v)
    .map((item) => (isRecord(item) ? first(item.text, item.content, item.name) : str(item)))
    .filter(Boolean);
}

const oneLine = (v) => v.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- redaction / refusal

/** Keys whose values are credentials. A document carrying one is refused whole. */
const CREDENTIAL_KEY = /(?:^|_)(?:api_?key|apikey|token|secret|passw(?:or)?d|passphrase|credentials?|auth|authorization|bearer|cookies?|private_?key|access_?key|session_?(?:id|key|token))(?:_|$)|key$/i;
const APP_VALUE_SLOTS = new Set(['headers', 'env', 'environment']);

function isCredentialKey(key) {
  if (/password/i.test(key)) return true;
  return CREDENTIAL_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_'));
}

function credentialKeys(value, at = '', inApps = false) {
  if (Array.isArray(value)) return value.flatMap((item, i) => credentialKeys(item, `${at}[${i}]`, inApps));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = at ? `${at}.${key}` : key;
    if (inApps && APP_VALUE_SLOTS.has(key)) return [];
    return [...(isCredentialKey(key) ? [here] : []), ...credentialKeys(child, here, key === 'apps' || key === 'plugins')];
  });
}

function scrubDeep(value) {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]));
  return value;
}

// ---------------------------------------------------------------- parsing

function dropTrailingCommas(text) {
  let out = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1, i + 200))) continue;
    out += ch;
  }
  return out;
}

function looseJson(text) {
  for (const attempt of [text, dropTrailingCommas(text)]) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* the next repair */
    }
  }
  return undefined;
}

/** Every top-level {…}, by brace matching that respects strings. */
function bracedObjects(text) {
  const found = [];
  let unbalanced = 0;
  for (let at = text.indexOf('{'); at >= 0 && unbalanced < 50; ) {
    let depth = 0;
    let quoted = false;
    let end = -1;
    for (let i = at; i < text.length && end < 0; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch === '\\') i += 1;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) end = i;
    }
    if (end < 0) {
      unbalanced += 1;
      at = text.indexOf('{', at + 1);
    } else {
      found.push(text.slice(at, end + 1));
      at = text.indexOf('{', end + 1);
    }
  }
  return found;
}

const looksLikeExport = (v) => isRecord(v) && (v.format === EXPORT_FORMAT || OLD_FORMATS.has(v.format) || Array.isArray(v.bots));
const looksLikeBot = (v) =>
  isRecord(v) && Boolean(str(v.name)) && ['instructions', 'memories', 'user_facts', 'userFacts', 'skills', 'routines', 'apps'].some((k) => k in v);

function documentsIn(text) {
  const repaired = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const versions = repaired === text ? [text] : [text, repaired];
  for (const version of versions) {
    const whole = looseJson(version.trim());
    if (looksLikeExport(whole)) return [whole];
    if (looksLikeBot(whole)) return [{ bots: [whole] }];
    if (Array.isArray(whole) && whole.length && whole.every(looksLikeBot)) return [{ bots: whole }];
    const found = bracedObjects(version).map(looseJson).filter(looksLikeExport);
    if (found.length) return found;
  }
  return [];
}

function readBot(raw) {
  return {
    name: oneLine(first(raw.name)),
    title: oneLine(first(raw.title)),
    description: first(raw.description),
    instructions: first(raw.instructions, raw.soul, raw.systemPrompt),
    memories: strings(raw.memories),
    userFacts: strings(raw.user_facts ?? raw.userFacts),
    skills: list(raw.skills).flatMap((skill) => {
      if (typeof skill === 'string') return [{ name: skill.trim(), description: '', instructions: '' }];
      if (!isRecord(skill)) return [];
      return [{
        name: first(skill.name, skill.title),
        description: first(skill.description, skill.summary),
        instructions: first(skill.instructions, skill.body, skill.content, skill.text),
      }];
    }),
    routines: list(raw.routines).flatMap((routine) => (isRecord(routine) ? [{
      name: first(routine.name, routine.title),
      instruction: first(routine.instruction, routine.prompt, routine.instructions, routine.task),
      trigger: first(routine.trigger).toLowerCase(),
      cron: first(routine.schedule_cron, routine.cron, routine.cronExpression),
      when: first(routine.schedule_text, routine.schedule, routine.when),
      timeZone: first(routine.timezone, routine.timeZone, routine.tz),
      paused: routine.paused === true,
      skills: strings(routine.skills),
      details: first(routine.trigger_details, routine.details),
    }] : [])),
    apps: list(raw.apps ?? raw.plugins ?? raw.integrations).flatMap((app) => {
      if (typeof app === 'string') return [{ name: app.trim(), url: '' }];
      if (!isRecord(app)) return [];
      const name = first(app.name, app.label, app.id, app.slug);
      return name ? [{ name: oneLine(name), url: first(app.mcp_url, app.mcpUrl, app.url) }] : [];
    }),
  };
}

/** One bot per name: repeated or split exports import each thing once. */
export function mergeBots(bots) {
  const merged = new Map();
  for (const bot of bots) {
    const key = bot.name.toLowerCase();
    const into = merged.get(key);
    if (!into) {
      merged.set(key, structuredClone(bot));
      continue;
    }
    const union = (mine, theirs) => [...new Map([...mine, ...theirs].map((item) => [JSON.stringify(item), item])).values()];
    merged.set(key, {
      name: into.name,
      title: bot.title || into.title,
      description: bot.description || into.description,
      instructions: bot.instructions || into.instructions,
      memories: union(into.memories, bot.memories),
      userFacts: union(into.userFacts, bot.userFacts),
      skills: union(into.skills, bot.skills),
      routines: union(into.routines, bot.routines),
      apps: union(into.apps, bot.apps),
    });
  }
  return [...merged.values()];
}

/**
 * Bots out of an export: a saved file, or the reply pasted back. Refuses a document
 * that carries credentials, and scrubs token-shaped text everywhere else.
 */
export function parseExport(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  if (raw.length > MAX_CHARS) throw new ImportError('tooLarge');
  const documents = documentsIn(raw);
  if (!documents.length) throw new ImportError(raw.split('{').length > raw.split('}').length ? 'cutOff' : 'notExport');
  const refused = documents.flatMap((document) => credentialKeys(document));
  if (refused.length) throw new ImportError('credentials', refused.slice(0, 5));
  if (documents.some((d) => typeof d.version === 'number' && d.version > 1)) throw new ImportError('newerVersion');
  const bots = documents
    .flatMap((document) => (Array.isArray(document.bots) ? document.bots.filter(isRecord) : [document]))
    .map(readBot)
    .filter((bot) => bot.name)
    .map((bot) => scrubDeep(bot));
  if (!bots.length) throw new ImportError('notExport');
  return mergeBots(bots);
}

// ---------------------------------------------------------------- planning

const slug = (value, max = 60) =>
  value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');

const CLOCK_TRIGGERS = new Set(['', 'schedule', 'scheduled', 'time', 'cron', 'interval']);

/** What a person should reread: a clock we could not read is a routine they must re-time here. */
function readableClock(routine) {
  if (!CLOCK_TRIGGERS.has(routine.trigger)) return null;
  const label = routine.cron || routine.when;
  return label && label.trim() ? label.trim() : null;
}

/**
 * What an import writes, before anything touches the disk. One entry per bot.
 * Routines with a readable clock become one-node graphs; the rest become notes.
 */
export function planImport(bots) {
  return bots.map((bot) => {
    const folder = slug(bot.name) || 'bot';
    const memory = [];
    if (bot.instructions) memory.push('## Instructions\n', bot.instructions.trim(), '');
    if (bot.memories.length) memory.push('## What it remembers\n', ...bot.memories.map((m) => `- ${oneLine(m)}`), '');
    if (bot.userFacts.length) memory.push('## About the person\n', ...bot.userFacts.map((m) => `- ${oneLine(m)}`), '');
    const memoryText = memory.length ? `# ${bot.title || bot.name} (imported)\n\n` + memory.join('\n').trimEnd() + '\n' : null;

    const skills = [];
    for (const skill of bot.skills.slice(0, MAX_SKILLS)) {
      const body = skill.instructions.trim();
      if (!body) continue;
      const name = slug(skill.name) || `skill-${skills.length + 1}`;
      const description = oneLine(skill.description || body.split('\n').find((l) => l.trim()) || name).slice(0, 400);
      const front = ['---', `name: ${oneLine(skill.name) || name}`, `description: ${description}`, '---', ''].join('\n');
      skills.push({ name, file: path.posix.join('skills', name, 'SKILL.md'), text: `${front}\n${body}\n` });
    }

    const graphs = [];
    const onClock = [];
    const onEvent = [];
    const graphNames = new Set();
    for (const routine of bot.routines) {
      if (!routine.instruction) continue;
      const clock = readableClock(routine);
      if (!clock) {
        onEvent.push(routine);
        continue;
      }
      if (graphs.length >= MAX_ROUTINES) continue;
      let id = slug(routine.name) || `routine-${graphs.length + 1}`;
      for (let n = 2; graphNames.has(id); n += 1) id = `${slug(routine.name) || 'routine'}-${n}`;
      graphNames.add(id);
      const graph = {
        goal: `${bot.name}: ${routine.name || 'routine'}`,
        nodes: [{ id: 'run', task: routine.instruction, verify: [] }],
      };
      graphs.push({ id, file: path.posix.join('.stewie', 'graphs', `${folder}-${id}.json`), graph, routine });
      onClock.push(routine);
    }

    const notes = [];
    if (onClock.length) {
      notes.push('## Routines, and when they used to run', '');
      notes.push('stewie has no scheduler: these are graphs you start yourself. The clock is what the old bot used.', '');
      for (const routine of onClock) {
        const found = graphs.find((g) => g.routine === routine);
        const clock = readableClock(routine);
        const zone = routine.timeZone ? ` (${routine.timeZone})` : '';
        notes.push(`- ${routine.name || 'routine'} — ${clock}${zone}${routine.paused ? ', paused there' : ''} → ${found ? found.file : 'not written'}`);
      }
      notes.push('');
    }
    if (onEvent.length) {
      notes.push('## Routines that start on an event', '');
      notes.push('These need a trigger stewie does not have. Set each one up again in a graph of its own.', '');
      for (const routine of onEvent) {
        notes.push(`### ${routine.name || 'routine'}`, '');
        notes.push(`- Trigger: ${routine.trigger || 'unknown'}`);
        if (routine.details) notes.push(`- Details: ${oneLine(routine.details)}`);
        notes.push('', routine.instruction.trim(), '');
      }
    }
    if (bot.apps.length) {
      notes.push('## Apps to connect again', '');
      notes.push('stewie does not hold logins. Connect these where the work actually needs them.', '');
      for (const app of bot.apps) notes.push(`- ${app.name}${app.url ? ` — ${app.url}` : ''}`);
      notes.push('');
    }
    const migrationText = notes.length
      ? `# ${bot.name}: what needs a person\n\n${notes.join('\n').trimEnd()}\n`
      : null;

    return {
      bot,
      folder,
      memoryText,
      skills,
      graphs,
      migrationText,
      counts: {
        memories: bot.memories.length + bot.userFacts.length,
        skills: skills.length,
        routines: onClock.length,
        eventRoutines: onEvent.length,
        apps: bot.apps.length,
      },
    };
  });
}

/** Write a plan under the repo. Existing files are kept unless `force`. */
export function writeImport(repoRoot, plan, { force = false } = {}) {
  const written = [];
  const skipped = [];
  const put = (rel, text) => {
    const file = path.join(repoRoot, rel);
    if (fs.existsSync(file) && !force) {
      skipped.push(rel);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    written.push(rel);
  };

  for (const item of plan) {
    const base = path.join('.stewie', 'imports', item.folder);
    if (item.memoryText) put(path.join(base, 'MEMORY.md'), item.memoryText);
    if (item.migrationText) put(path.join(base, 'MIGRATION.md'), item.migrationText);
    for (const skill of item.skills) put(path.join(base, skill.file), skill.text);
    for (const g of item.graphs) put(g.file, JSON.stringify(g.graph, null, 2) + '\n');
  }
  return { written, skipped };
}

/** One paragraph for the terminal (and the inbox) about what just happened. */
export function describePlan(plan, { written = [], skipped = [] } = {}) {
  const lines = [];
  for (const item of plan) {
    const c = item.counts;
    lines.push(`${item.bot.name}: ${c.routines} runnable routine${c.routines === 1 ? '' : 's'}, ${c.skills} skill${c.skills === 1 ? '' : 's'}, ${c.memories} memor${c.memories === 1 ? 'y' : 'ies'}`);
    if (c.eventRoutines) lines.push(`  ${c.eventRoutines} routine${c.eventRoutines === 1 ? ' starts' : 's start'} on an event — written to MIGRATION.md`);
    if (c.apps) lines.push(`  ${c.apps} app${c.apps === 1 ? '' : 's'} to connect again — written to MIGRATION.md`);
  }
  if (written.length) lines.push(`wrote ${written.length} file${written.length === 1 ? '' : 's'}`);
  if (skipped.length) lines.push(`kept ${skipped.length} existing file${skipped.length === 1 ? '' : 's'} (use --force to overwrite)`);
  return lines.join('\n');
}
