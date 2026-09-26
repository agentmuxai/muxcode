// Instruction files (CLAUDE.md by Claude Code's rules, plus AGENTS.md) reach
// the model as the first user message, ahead of the prompt.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { lastUserText, runMuxcode, startFakeModel } from './helpers.mjs';

let model;
before(async () => { model = await startFakeModel(); });
after(async () => { await model.close(); });

/** Run once and return the first request's messages. */
async function messagesFor(files, { cwd = 'proj', env = {}, prompt = 'the task' } = {}) {
  const n = model.requests.length;
  const r = await runMuxcode(['run', '-p'], { stdin: prompt, modelUrl: model.url, files, subdir: cwd, env });
  assert.equal(r.code, 0, r.stderr);
  return model.requests[n].messages;
}

/** The instructions message's text, or undefined if none was sent. */
async function instructionsFor(files, opts) {
  const messages = await messagesFor(files, opts);
  const users = messages.filter(m => m.role === 'user');
  assert.ok(users.length <= 2, 'at most one instructions message before the prompt');
  return users.length === 2 ? users[0].content : undefined;
}

/** Assert each needle appears, once, in this order. */
function assertOrder(text, needles) {
  let at = -1;
  for (const needle of needles) {
    const i = text.indexOf(needle);
    assert.ok(i >= 0, `missing ${needle}`);
    assert.equal(text.indexOf(needle, i + 1), -1, `${needle} appears more than once`);
    assert.ok(i > at, `${needle} is out of order`);
    at = i;
  }
}

test('user and project files are concatenated broadest first, walking up from the cwd', async () => {
  const text = await instructionsFor({
    '.claude/CLAUDE.md': 'USER_LEVEL',
    'proj/.git/': null,
    'proj/AGENTS.md': 'ROOT_AGENTS',
    'proj/CLAUDE.md': 'ROOT_CLAUDE',
    'proj/CLAUDE.local.md': 'ROOT_LOCAL',
    'proj/sub/.claude/CLAUDE.md': 'SUB_DOT_CLAUDE',
    'proj/sub/deeper/CLAUDE.md': 'DEEP_CLAUDE',
    'proj/sub/deeper/CLAUDE.local.md': 'DEEP_LOCAL',
  }, { cwd: 'proj/sub/deeper' });
  assert.match(text, /^<system-reminder>/);
  assert.match(text, /<\/system-reminder>$/);
  assertOrder(text, ['USER_LEVEL', 'ROOT_AGENTS', 'ROOT_CLAUDE', 'ROOT_LOCAL', 'SUB_DOT_CLAUDE', 'DEEP_CLAUDE', 'DEEP_LOCAL']);
  assert.match(text, /Contents of \S+CLAUDE\.md \(user's private global instructions for all projects\):\n\nUSER_LEVEL/);
  assert.match(text, /Contents of \S+CLAUDE\.local\.md \(user's private project instructions, not checked in\):\n\nROOT_LOCAL/);
  assert.match(text, /Contents of \S+AGENTS\.md \(project instructions, checked into the codebase\):\n\nROOT_AGENTS/);
});

test('the instructions come before the prompt, and the system prompt is unchanged', async () => {
  const plain = await messagesFor({ 'proj/.git/': null });
  const withFiles = await messagesFor({ 'proj/.git/': null, 'proj/CLAUDE.md': 'BE_TERSE' });
  assert.deepEqual(withFiles.map(m => m.role), ['system', 'user', 'user']);
  assert.equal(withFiles[0].content, plain[0].content);
  assert.match(withFiles[0].content, /^You are Mux Code/);
  assert.doesNotMatch(withFiles[0].content, /BE_TERSE/);
  assert.match(withFiles[1].content, /BE_TERSE/);
  assert.equal(lastUserText({ messages: withFiles }), 'the task');
});

test('every ancestor directory is read, not only up to the repo root', async () => {
  const text = await instructionsFor({
    'outer/CLAUDE.md': 'ABOVE_REPO',
    'outer/proj/.git/': null,
    'outer/proj/CLAUDE.md': 'IN_REPO',
  }, { cwd: 'outer/proj' });
  assertOrder(text, ['ABOVE_REPO', 'IN_REPO']);
});

test("AgentMux's layout: a parent directory's CLAUDE.md is read with no .git anywhere", async () => {
  // An agent runs in ~/.agentmux/agents/<agent>/ (under the temp HOME here).
  const text = await instructionsFor({
    '.agentmux/agents/CLAUDE.md': 'FLEET_RULES\n@shared/jekt.md',
    '.agentmux/agents/shared/jekt.md': 'JEKT_RULES',
    '.agentmux/agents/other/secret.md': 'OTHER_AGENT',
    '.agentmux/agents/agent1/CLAUDE.md': 'AGENT_SOUL\n@../other/secret.md',
  }, { cwd: '.agentmux/agents/agent1' });
  assertOrder(text, ['FLEET_RULES', 'JEKT_RULES', 'AGENT_SOUL']);
  assert.doesNotMatch(text, /OTHER_AGENT/, "an import outside the file's own tree and the project's is not followed");
  assert.match(text, /@\.\.\/other\/secret\.md/);
});

test("a git worktree (.git is a file) marks the project, whose rules are read", async () => {
  const text = await instructionsFor({
    'proj/.git': 'gitdir: /elsewhere',
    'proj/.claude/rules/r.md': 'WORKTREE_RULE',
  }, { cwd: 'proj/sub' });
  assert.match(text, /WORKTREE_RULE/);
});

test('rules come from the project (the git root, else the cwd), not from every ancestor', async () => {
  let text = await instructionsFor({
    'proj/.claude/rules/r.md': 'PARENT_RULE',
    'proj/sub/.claude/rules/r.md': 'CWD_RULE',
  }, { cwd: 'proj/sub' });
  assert.match(text, /CWD_RULE/);
  assert.doesNotMatch(text, /PARENT_RULE/);

  text = await instructionsFor({
    'proj/.git/': null,
    'proj/.claude/rules/r.md': 'ROOT_RULE',
    'proj/sub/.claude/rules/r.md': 'SUB_RULE',
  }, { cwd: 'proj/sub' });
  assert.match(text, /ROOT_RULE/);
  assert.doesNotMatch(text, /SUB_RULE/);
});

test('@imports: relative to the importing file, 4 levels deep, not in code, missing and cyclic ignored', async () => {
  const text = await instructionsFor({
    'proj/.git/': null,
    'proj/CLAUDE.md': [
      'TOP',
      '@docs/one.md',
      'Also see @missing.md and mail me at someone@example.com.',
      'Inline `@docs/span.md` stays.',
      '```',
      '@docs/fenced.md',
      '```',
      '@cycle/a.md',
      '@../outside.md',
    ].join('\n'),
    'proj/docs/one.md': 'LEVEL1\n@sub/two.md',
    'proj/docs/sub/two.md': 'LEVEL2 @three.md',
    'proj/docs/sub/three.md': 'LEVEL3\n@../four.md',
    'proj/docs/four.md': 'LEVEL4\n@five.md',
    'proj/docs/five.md': 'LEVEL5',
    'proj/docs/span.md': 'SPAN_CONTENT',
    'proj/docs/fenced.md': 'FENCED_CONTENT',
    'proj/cycle/a.md': 'CYCLE_A\n@b.md',
    'proj/cycle/b.md': 'CYCLE_B\n@a.md',
    'outside.md': 'OUTSIDE_PROJECT',
  });
  assertOrder(text, ['TOP', 'LEVEL1', 'LEVEL2', 'LEVEL3', 'LEVEL4', 'CYCLE_A', 'CYCLE_B']);
  assert.doesNotMatch(text, /LEVEL5/, 'a 5th-level import is not followed');
  assert.match(text, /@five\.md/, 'an import not followed is left as written');
  assert.match(text, /Also see @missing\.md and mail me at someone@example\.com\./);
  assert.match(text, /`@docs\/span\.md`/);
  assert.doesNotMatch(text, /SPAN_CONTENT|FENCED_CONTENT/);
  assert.match(text, /```\n@docs\/fenced\.md\n```/);
  assert.doesNotMatch(text, /OUTSIDE_PROJECT/, 'project files cannot import from outside the project');
});

test('the user-level file can import from home with @~/', async () => {
  const text = await instructionsFor({
    '.claude/CLAUDE.md': 'USER\n@~/shared/notes.md',
    'shared/notes.md': 'SHARED_NOTES',
  });
  assertOrder(text, ['USER', 'SHARED_NOTES']);
});

test("AgentMux's @.claude/AGENTMUX_MEMORY.md import in a user-owned CLAUDE.md", async () => {
  // agentmux-srv/src/backend/agent_config.rs appends exactly this block.
  const text = await instructionsFor({
    'proj/CLAUDE.md': '# My own notes\n\nUSER_OWNED\n\n<!-- agentmux:managed-import (safe to delete this line to opt out) -->\n@.claude/AGENTMUX_MEMORY.md\n',
    'proj/.claude/AGENTMUX_MEMORY.md': '# Memory\nIMPORTANT: AgentMux instructions.\n\nAGENT_SOUL',
  });
  assertOrder(text, ['USER_OWNED', 'AGENT_SOUL']);
  assert.doesNotMatch(text, /managed-import|@\.claude/);
});

test('AGENTS.md is read alongside CLAUDE.md, once even if CLAUDE.md imports it', async () => {
  const text = await instructionsFor({
    'proj/.git/': null,
    'proj/AGENTS.md': 'SHARED_AGENTS_RULES',
    'proj/CLAUDE.md': '@AGENTS.md\nCLAUDE_ONLY',
  });
  assertOrder(text, ['SHARED_AGENTS_RULES', 'CLAUDE_ONLY']);
});

test('block HTML comments are stripped, except in code fences', async () => {
  const text = await instructionsFor({
    'proj/CLAUDE.md': [
      'KEEP_1',
      '<!-- one-line maintainer note -->',
      '<!--',
      'MULTI_LINE_NOTE',
      '-->',
      'KEEP_2',
      '```html',
      '<!-- FENCED_COMMENT -->',
      '```',
    ].join('\n'),
  });
  assertOrder(text, ['KEEP_1', 'KEEP_2', '<!-- FENCED_COMMENT -->']);
  assert.doesNotMatch(text, /maintainer note|MULTI_LINE_NOTE/);
});

test('.claude/rules: rules without paths: load after the root files; path-scoped rules are skipped', async () => {
  const text = await instructionsFor({
    'proj/.git/': null,
    'proj/CLAUDE.md': 'ROOT_CLAUDE',
    'proj/.claude/rules/a-style.md': '---\ndescription: house style\n---\nRULE_FRONTMATTER',
    'proj/.claude/rules/b-plain.md': 'RULE_PLAIN',
    'proj/.claude/rules/nested/c.md': 'RULE_NESTED',
    'proj/.claude/rules/ts-only.md': '---\npaths:\n  - "src/**/*.ts"\n---\nRULE_PATH_SCOPED',
    'proj/sub/CLAUDE.md': 'SUB_CLAUDE',
  }, { cwd: 'proj/sub' });
  assertOrder(text, ['ROOT_CLAUDE', 'RULE_FRONTMATTER', 'RULE_PLAIN', 'RULE_NESTED', 'SUB_CLAUDE']);
  assert.doesNotMatch(text, /RULE_PATH_SCOPED|description: house style/);
});

test('the total is capped at 32 KiB, keeping the most specific files', async () => {
  const kib = n => 'x'.repeat(n * 1024);
  const text = await instructionsFor({
    '.claude/CLAUDE.md': `USER_START ${kib(10)}`,
    'proj/.git/': null,
    'proj/CLAUDE.md': `ROOT_START ${kib(30)} ROOT_END`,
    'proj/sub/CLAUDE.md': `SUB_START ${kib(10)} SUB_END`,
  }, { cwd: 'proj/sub' });
  assert.match(text, /SUB_START x+ SUB_END/, 'the nearest file is kept whole');
  assert.match(text, /ROOT_START/, 'the next one keeps its head');
  assert.doesNotMatch(text, /ROOT_END/);
  assert.match(text, /\[\.\.\. truncated: \d+ more bytes of \S+CLAUDE\.md not shown\]/);
  assert.doesNotMatch(text, /USER_START/, 'broader files are dropped');
  assert.match(text, /\[Instructions exceeded 32 KiB; omitted: [^\]]*\.claude[\\/]CLAUDE\.md\]/);
  assert.ok(Buffer.byteLength(text) < 33 * 1024, `${Buffer.byteLength(text)} bytes`);
});

test('MUXCODE_DISABLE_INSTRUCTIONS=1 sends no instructions', async () => {
  const files = { '.claude/CLAUDE.md': 'USER', 'proj/CLAUDE.md': 'PROJECT' };
  assert.equal(await instructionsFor(files, { env: { MUXCODE_DISABLE_INSTRUCTIONS: '1' } }), undefined);
  assert.match(await instructionsFor(files, { env: { MUXCODE_DISABLE_INSTRUCTIONS: '0' } }), /PROJECT/);
});

test('a file that is empty once comments are stripped is not sent', async () => {
  // Any instruction files above the temp dir are read too, so don't expect none at all.
  const text = await instructionsFor({ 'proj/.git/': null, 'proj/CLAUDE.md': '<!-- only a comment -->\n' });
  assert.doesNotMatch(text ?? '', /proj[\\/]CLAUDE\.md/);
});
