// Sessions: AgentMux runs one process per turn and passes `--resume <id>`, so
// the conversation has to be saved and reloaded between processes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { FIXTURE_MCP_CONFIG, runMuxcode, startFakeAnthropic, startFakeModel } from './helpers.mjs';

const ARGS = ['run', '-p', '--dangerously-skip-permissions'];
let root;
let configDir;
let work;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'muxcode-sessions-'));
  configDir = path.join(root, 'config');
  work = path.join(root, 'work');
  mkdirSync(work);
});
after(() => rmSync(root, { recursive: true, force: true }));

const env = () => ({ MUXCODE_CONFIG_DIR: configDir });
const sessionIdOf = r => r.frames.find(f => f.type === 'system').session_id;
const roles = messages => messages.map(m => m.role);

test('--resume reloads the conversation, and the new turn is saved too', async () => {
  const model = await startFakeModel((_b, n) => ({ content: `answer ${n}` }));
  try {
    const first = await runMuxcode(ARGS, { stdin: 'first question', modelUrl: model.url, env: env(), cwd: work });
    assert.equal(first.code, 0, first.stderr);
    const id = sessionIdOf(first);
    assert.ok(existsSync(path.join(configDir, 'sessions', `${id}.jsonl`)));

    const second = await runMuxcode([...ARGS, '--resume', id], { stdin: 'second question', modelUrl: model.url, env: env(), cwd: work });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(sessionIdOf(second), id);
    const msgs = model.requests[1].messages;
    assert.deepEqual(roles(msgs), ['system', 'user', 'assistant', 'user']);
    assert.equal(msgs[1].content, 'first question');
    assert.equal(msgs[2].content, 'answer 0');
    assert.equal(msgs[3].content, 'second question');

    const third = await runMuxcode([...ARGS, '--resume', id], { stdin: 'third', modelUrl: model.url, env: env(), cwd: work });
    assert.equal(third.code, 0, third.stderr);
    assert.deepEqual(roles(model.requests[2].messages), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  } finally {
    await model.close();
  }
});

test('tool calls and their results survive a resume', async () => {
  const model = await startFakeModel((_b, n) =>
    n === 0
      ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_thing', arguments: '{}' } }] }
      : { content: `answer ${n}` });
  try {
    const cwd = mkdtempSync(path.join(root, 'tools-'));
    writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify(FIXTURE_MCP_CONFIG));
    const first = await runMuxcode(ARGS, { stdin: 'use the tool', modelUrl: model.url, env: env(), cwd });
    assert.equal(first.code, 0, first.stderr);
    const id = sessionIdOf(first);
    await runMuxcode([...ARGS, '--resume', id], { stdin: 'again', modelUrl: model.url, env: env(), cwd });
    const msgs = model.requests[2].messages;
    assert.deepEqual(roles(msgs), ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    assert.equal(msgs[2].tool_calls[0].id, 'call_1');
    assert.deepEqual(msgs[3], { role: 'tool', content: 'the thing', tool_call_id: 'call_1' });
  } finally {
    await model.close();
  }
});

test('--continue resumes the latest session started in this directory', async () => {
  const model = await startFakeModel((_b, n) => ({ content: `answer ${n}` }));
  try {
    const cwd = mkdtempSync(path.join(root, 'continue-'));
    const first = await runMuxcode(ARGS, { stdin: 'hello', modelUrl: model.url, env: env(), cwd });
    const again = await runMuxcode([...ARGS, '--continue'], { stdin: 'and again', modelUrl: model.url, env: env(), cwd });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(sessionIdOf(again), sessionIdOf(first));
    assert.deepEqual(roles(model.requests[1].messages), ['system', 'user', 'assistant', 'user']);

    const elsewhere = await runMuxcode([...ARGS, '--continue'], { stdin: 'new place', modelUrl: model.url, env: env() });
    assert.notEqual(sessionIdOf(elsewhere), sessionIdOf(first), 'another directory starts a new session');
  } finally {
    await model.close();
  }
});

test('an unknown --resume id starts that session fresh', async () => {
  const model = await startFakeModel();
  try {
    const r = await runMuxcode([...ARGS, '--resume', 'mux-unknown1'], { stdin: 'hi', modelUrl: model.url, env: env(), cwd: work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /no saved session mux-unknown1; starting it fresh/);
    assert.equal(sessionIdOf(r), 'mux-unknown1');
    assert.deepEqual(roles(model.requests[0].messages), ['system', 'user']);
    assert.ok(existsSync(path.join(configDir, 'sessions', 'mux-unknown1.jsonl')));
  } finally {
    await model.close();
  }
});

test('a session id that is not a safe file name is rejected', async () => {
  const r = await runMuxcode([...ARGS, '--resume', '../escape'], { stdin: 'hi', env: env() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid session id/);
});

test('a tool call left without its result by a crash is dropped on resume', async () => {
  const model = await startFakeModel();
  try {
    const id = 'mux-crashed1';
    mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
    const lines = [
      { type: 'meta', id, cwd: work, created_at: new Date().toISOString() },
      { type: 'message', message: { role: 'user', content: 'earlier' } },
      { type: 'message', message: { role: 'assistant', content: 'earlier answer' } },
      { type: 'message', message: { role: 'user', content: 'do something' } },
      { type: 'message', message: { role: 'assistant', content: [], tool_calls: [{ id: 'c9', name: 'x', input: {} }] } },
    ];
    writeFileSync(path.join(configDir, 'sessions', `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n{"type":"mess');
    const r = await runMuxcode([...ARGS, '--resume', id], { stdin: 'retry', modelUrl: model.url, env: env(), cwd: work });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(roles(model.requests[0].messages), ['system', 'user', 'assistant', 'user', 'user']);
    assert.equal(model.requests[0].messages.at(-1).content, 'retry');
  } finally {
    await model.close();
  }
});

test('resuming a run interrupted before the model answered sends valid Anthropic history', async () => {
  // Interrupted mid-request: the session ends with the user's prompt and no reply.
  const api = await startFakeAnthropic(() => ({ text: 'ok' }));
  try {
    const id = 'mux-interrupted1';
    mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
    const lines = [
      { type: 'meta', id, cwd: work, created_at: new Date().toISOString() },
      { type: 'message', message: { role: 'user', content: 'first' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
      { type: 'message', message: { role: 'user', content: 'interrupted prompt' } },
    ];
    writeFileSync(path.join(configDir, 'sessions', `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const r = await runMuxcode([...ARGS, '--resume', id], {
      stdin: 'try again',
      env: { ...env(), ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: api.url },
      cwd: work,
    });
    assert.equal(r.code, 0, r.stderr);
    const msgs = api.requests[0].messages;
    for (let i = 1; i < msgs.length; i++) assert.notEqual(msgs[i].role, msgs[i - 1].role, `turns ${i - 1} and ${i} share a role`);
    assert.deepEqual(msgs.at(-1).content, [
      { type: 'text', text: 'interrupted prompt' },
      { type: 'text', text: 'try again' },
    ]);
  } finally {
    await api.close();
  }
});

test('a run stopped by --max-turns exits 3', async () => {
  const model = await startFakeModel(() => ({
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'missing', arguments: '{}' } }],
  }));
  try {
    const r = await runMuxcode([...ARGS, '--max-turns', '1'], { stdin: 'loop', modelUrl: model.url, env: env() });
    assert.equal(r.code, 3);
  } finally {
    await model.close();
  }
});

// Windows can't deliver a catchable SIGINT to a child process; CI runs this on Linux.
test('an interrupt writes an Interrupted result, keeps the transcript, and exits 130', { skip: process.platform === 'win32' }, async () => {
  const model = await startFakeModel(() => ({ content: 'too late', delayMs: 10_000 }));
  try {
    const r = await runMuxcode(ARGS, {
      stdin: 'slow one',
      modelUrl: model.url,
      env: env(),
      cwd: work,
      onSpawn: child => {
        const poll = setInterval(() => {
          if (model.requests.length > 0) {
            clearInterval(poll);
            child.kill('SIGINT');
          }
        }, 50);
      },
    });
    assert.equal(r.code, 130, r.stderr);
    const result = r.frames.at(-1);
    assert.equal(result.type, 'result');
    assert.equal(result.is_error, true);
    assert.equal(result.result, 'Interrupted');
    const id = sessionIdOf(r);
    const saved = readFileSync(path.join(configDir, 'sessions', `${id}.jsonl`), 'utf8');
    assert.match(saved, /slow one/);
  } finally {
    await model.close();
  }
});

test('on resume, instructions come first and are not saved in the session', async () => {
  const model = await startFakeModel((_b, n) => ({ content: `answer ${n}` }));
  try {
    const cwd = mkdtempSync(path.join(root, 'instr-'));
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Always be brief.');
    const first = await runMuxcode(ARGS, { stdin: 'one', modelUrl: model.url, env: env(), cwd });
    assert.equal(first.code, 0, first.stderr);
    const id = sessionIdOf(first);
    const second = await runMuxcode([...ARGS, '--resume', id], { stdin: 'two', modelUrl: model.url, env: env(), cwd });
    assert.equal(second.code, 0, second.stderr);

    const msgs = model.requests[1].messages;
    assert.deepEqual(roles(msgs), ['system', 'user', 'user', 'assistant', 'user']);
    assert.match(msgs[1].content, /Always be brief\./);
    assert.equal(msgs[2].content, 'one');
    const saved = readFileSync(path.join(configDir, 'sessions', `${id}.jsonl`), 'utf8');
    assert.doesNotMatch(saved, /Always be brief/);
  } finally {
    await model.close();
  }
});
