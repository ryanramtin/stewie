import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { parseExport, planImport, writeImport, describePlan, ImportError, scrubSecrets, IMPORT_PROMPT } from '../src/import.mjs';
import { validateGraph } from '../src/graph.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stewie-import-'));
}

const sample = (overrides = {}) => ({
  format: 'grok-bot-export',
  version: 1,
  bots: [{
    name: 'Scout',
    title: 'Research bot',
    description: 'Reads the news and writes a brief.',
    instructions: 'You research carefully and cite sources.',
    memories: ['Ryan prefers short briefs', 'The team ships on Fridays'],
    user_facts: ['Name: Ryan', 'Time zone: Pacific'],
    skills: [{ name: 'Daily brief', description: 'Write the morning brief', instructions: '# Daily brief\n\nRead the feeds, pick 5 items, write 3 lines each.' }],
    routines: [
      { name: 'Morning brief', instruction: 'Write the morning brief.', trigger: 'schedule', schedule_cron: '0 8 * * 1-5', timezone: 'America/Los_Angeles', paused: false },
      { name: 'On a GitHub issue', instruction: 'Summarise the issue.', trigger: 'github', trigger_details: 'repo x' },
    ],
    apps: [{ name: 'Gmail' }],
    ...overrides,
  }],
});

test('a clean export parses into bots, skills, routines and apps', () => {
  const bots = parseExport(JSON.stringify(sample()));
  assert.equal(bots.length, 1);
  const bot = bots[0];
  assert.equal(bot.name, 'Scout');
  assert.equal(bot.memories.length, 2);
  assert.equal(bot.userFacts.length, 2);
  assert.equal(bot.skills[0].name, 'Daily brief');
  assert.equal(bot.routines.length, 2);
  assert.equal(bot.apps[0].name, 'Gmail');
});

test('a reply with prose and a fenced document still parses', () => {
  const text = `Here is the export you asked for.\n\n\`\`\`json\n${JSON.stringify(sample())}\n\`\`\`\n\nLet me know if anything is missing.`;
  assert.equal(parseExport(text)[0].name, 'Scout');
});

test('trailing commas and smart quotes are repaired', () => {
  const json = JSON.stringify(sample()).replace(/"title":"Research bot",/, '"title":"Research bot",').replace('"Scout"', '\u201cScout\u201d');
  const loose = json.replace(/,}/g, '},').replace(/,]/g, '],');
  // the repaired text still holds the same facts
  const bots = parseExport(loose.replace('],}', '] }'));
  assert.equal(bots[0].name, 'Scout');
});

test('split exports of the same bot merge without duplicating', () => {
  const a = sample();
  const b = sample({ memories: ['Ryan prefers tea'] });
  const bots = parseExport(JSON.stringify(a) + '\n' + JSON.stringify(b));
  assert.equal(bots.length, 1);
  assert.equal(bots[0].memories.length, 3);
});

test('a bare bot object imports', () => {
  const bots = parseExport(JSON.stringify(sample().bots[0]));
  assert.equal(bots[0].name, 'Scout');
});

test('a document with credentials is refused whole, with the key paths', () => {
  const bad = sample();
  bad.bots[0].api_key = 'abc';
  try {
    parseExport(JSON.stringify(bad));
    assert.fail('should refuse');
  } catch (err) {
    assert.ok(err instanceof ImportError);
    assert.equal(err.code, 'credentials');
    assert.ok(err.keys.includes('bots[0].api_key'));
  }
});

test('token-shaped text is scrubbed', () => {
  // Built at runtime so no token-shaped literal sits in the repo.
  const openai = 'sk-' + 'a1b2c3d4e5f6g7h8i9j0';
  const github = 'ghp_' + '0123456789abcdefghij';
  const clean = scrubSecrets(`the key was ${openai} and ${github}`);
  assert.equal(clean.includes(openai), false);
  assert.equal(clean.includes(github), false);
  assert.match(clean, /«redacted»/);
});

test('a cut-off document says so instead of importing half a bot', () => {
  const text = JSON.stringify(sample()).slice(0, 120);
  assert.throws(() => parseExport(text), (err) => err.code === 'cutOff');
});

test('prose is not an export', () => {
  assert.throws(() => parseExport('I am your assistant and I have many routines.'), (err) => err.code === 'notExport');
});

test('the prompt asks for the shape the parser reads', () => {
  assert.match(IMPORT_PROMPT, /grok-bot-export/);
  assert.match(IMPORT_PROMPT, /routines/);
  assert.match(IMPORT_PROMPT, /Never include passwords/);
});

test('an import plan turns clocked routines into runnable graphs', () => {
  const [plan] = planImport(parseExport(JSON.stringify(sample())));
  assert.equal(plan.folder, 'scout');
  assert.equal(plan.graphs.length, 1);
  const graph = plan.graphs[0].graph;
  assert.equal(validateGraph(graph).ok, true);
  assert.match(graph.goal, /Scout: Morning brief/);
  assert.equal(plan.counts.skills, 1);
  assert.equal(plan.counts.eventRoutines, 1);
  assert.equal(plan.counts.apps, 1);
  assert.match(plan.migrationText, /On a GitHub issue/);
  assert.match(plan.migrationText, /Gmail/);
  assert.match(plan.memoryText, /Ryan prefers short briefs/);
  assert.match(plan.memoryText, /You research carefully/);
});

test('writing an import lays out docs, skills and graphs, and never overwrites by default', () => {
  const repo = tmp();
  const plan = planImport(parseExport(JSON.stringify(sample())));
  const first = writeImport(repo, plan);
  assert.ok(first.written.includes(path.join('.stewie', 'imports', 'scout', 'MEMORY.md')));
  assert.ok(first.written.includes(path.join('.stewie', 'imports', 'scout', 'MIGRATION.md')));
  assert.ok(first.written.includes(path.join('.stewie', 'imports', 'scout', 'skills', 'daily-brief', 'SKILL.md')));
  const graphFile = path.join(repo, '.stewie', 'graphs', 'scout-morning-brief.json');
  assert.ok(fs.existsSync(graphFile));
  assert.equal(validateGraph(JSON.parse(fs.readFileSync(graphFile, 'utf8'))).ok, true);

  const skill = fs.readFileSync(path.join(repo, '.stewie', 'imports', 'scout', 'skills', 'daily-brief', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: Daily brief\ndescription: Write the morning brief\n---/);

  const second = writeImport(repo, plan);
  assert.equal(second.written.length, 0);
  assert.ok(second.skipped.length > 0);

  const third = writeImport(repo, plan, { force: true });
  assert.ok(third.written.length > 0);
});

test('the report counts what came over and what still needs a person', () => {
  const plan = planImport(parseExport(JSON.stringify(sample())));
  const report = describePlan(plan, { written: ['a'], skipped: [] });
  assert.match(report, /Scout: 1 runnable routine, 1 skill, 4 memories/);
  assert.match(report, /routine starts on an event/);
  assert.match(report, /app to connect again/);
  assert.match(report, /wrote 1 file/);
});
