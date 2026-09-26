// How AgentMux invokes Mux Code: `muxcode run -p --dangerously-skip-permissions
// [--resume <sid>]` with the prompt written to stdin
// (agentmux-srv/src/backend/blockcontroller/subprocess/host_spawn.rs, argv.rs).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FIXTURE_MCP_CONFIG, lastUserText, runMuxcode, startFakeModel } from './helpers.mjs';

let model;
before(async () => { model = await startFakeModel(); });
after(async () => { await model.close(); });

test("AgentMux's exact invocation: -p is a flag and the prompt comes from stdin", async () => {
  const before = model.requests.length;
  const r = await runMuxcode(['run', '-p', '--dangerously-skip-permissions'], {
    stdin: 'hello from agentmux\n',
    modelUrl: model.url,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(model.requests.length, before + 1);
  assert.equal(lastUserText(model.requests[before]).trim(), 'hello from agentmux');

  const init = r.frames.find(f => f.type === 'system' && f.subtype === 'init');
  assert.equal(init.permissionMode, 'bypassPermissions');
  const result = r.frames.find(f => f.type === 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.result, 'done');
});

test('--resume keeps the session id and --permission-mode is honoured', async () => {
  const r = await runMuxcode(['run', '-p', '--permission-mode', 'acceptEdits', '--resume', 'mux-abc123'], {
    stdin: 'next turn',
    modelUrl: model.url,
  });
  assert.equal(r.code, 0, r.stderr);
  for (const f of r.frames) assert.equal(f.session_id, 'mux-abc123');
  assert.equal(r.frames[0].permissionMode, 'acceptEdits');
});

test('a positional prompt is used without reading stdin', async () => {
  const before = model.requests.length;
  const r = await runMuxcode(['run', '-p', 'fix', 'the', 'bug'], { modelUrl: model.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastUserText(model.requests[before]), 'fix the bug');
});

test('--prompt still works for scripts', async () => {
  const before = model.requests.length;
  const r = await runMuxcode(['run', '--prompt', 'from the option'], { modelUrl: model.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastUserText(model.requests[before]), 'from the option');
});

test('an unknown flag is dropped with a warning, not sent as the prompt', async () => {
  const before = model.requests.length;
  const r = await runMuxcode(['run', '-p', '--some-future-flag'], { stdin: 'real prompt', modelUrl: model.url });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /ignoring unknown option --some-future-flag/);
  assert.equal(lastUserText(model.requests[before]), 'real prompt');
});

test('prompt words that only look like options are kept', async () => {
  const before = model.requests.length;
  const r = await runMuxcode(['run', '-p', 'explain', '-1', 'and', '-', 'flag'], { modelUrl: model.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastUserText(model.requests[before]), 'explain -1 and - flag');
  assert.doesNotMatch(r.stderr, /ignoring unknown option/);
});

const BUILTINS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite'];
const READ_ONLY_BUILTINS = ['Read', 'Grep', 'Glob', 'TodoWrite'];

test('plan mode offers only read-only tools: built-in and MCP', async () => {
  const before = model.requests.length;
  const r = await runMuxcode(['run', '-p', '--permission-mode', 'plan'], {
    stdin: 'look around',
    modelUrl: model.url,
    files: { '.mcp.json': FIXTURE_MCP_CONFIG },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.frames[0].tools, [...READ_ONLY_BUILTINS, 'read_thing']);
  assert.deepEqual(model.requests[before].tools.map(t => t.function.name), [...READ_ONLY_BUILTINS, 'read_thing']);
});

test('other modes offer every tool, built-ins first', async () => {
  const before = model.requests.length;
  const r = await runMuxcode(['run', '-p', '--dangerously-skip-permissions'], {
    stdin: 'do it',
    modelUrl: model.url,
    files: { '.mcp.json': FIXTURE_MCP_CONFIG },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.frames[0].tools, [...BUILTINS, 'read_thing', 'write_thing']);
  assert.deepEqual(model.requests[before].tools.map(t => t.function.name), [...BUILTINS, 'read_thing', 'write_thing']);
});

test('an invalid permission mode fails before calling the model', async () => {
  const before = model.requests.length;
  const r = await runMuxcode(['run', '-p', '--permission-mode', 'yolo'], { stdin: 'x', modelUrl: model.url });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid --permission-mode "yolo"/);
  assert.equal(model.requests.length, before);
});

test('no prompt at all is an error', async () => {
  const r = await runMuxcode(['run', '-p'], { stdin: '', modelUrl: model.url });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no prompt provided/);
});

test('--output-format text prints only the result', async () => {
  const r = await runMuxcode(['run', '-p', '--output-format', 'text'], { stdin: 'hi', modelUrl: model.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'done\n');
});

test('--output-format json prints only the result object', async () => {
  const r = await runMuxcode(['run', '-p', '--output-format', 'json'], { stdin: 'hi', modelUrl: model.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].type, 'result');
});

test('--append-system-prompt adds to the system prompt; --system replaces it', async () => {
  let before = model.requests.length;
  let r = await runMuxcode(['run', '-p', '--append-system-prompt', 'Always answer in French.'], {
    stdin: 'hi',
    modelUrl: model.url,
  });
  assert.equal(r.code, 0, r.stderr);
  let system = model.requests[before].messages.find(m => m.role === 'system').content;
  assert.match(system, /^You are Mux Code/);
  assert.match(system, /Always answer in French\.$/);

  before = model.requests.length;
  r = await runMuxcode(['run', '-p', '--system', 'Custom.', '--append-system-prompt', 'Extra.'], {
    stdin: 'hi',
    modelUrl: model.url,
  });
  assert.equal(r.code, 0, r.stderr);
  system = model.requests[before].messages.find(m => m.role === 'system').content;
  assert.equal(system, 'Custom.\n\nExtra.');
});

test('--max-turns stops the loop', async () => {
  const looping = await startFakeModel(() => ({
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'missing_tool', arguments: '{}' } }],
  }));
  try {
    const r = await runMuxcode(['run', '-p', '--max-turns', '2'], { stdin: 'loop', modelUrl: looping.url });
    assert.equal(looping.requests.length, 2);
    assert.equal(r.code, 3, 'a run stopped by --max-turns exits 3');
    const result = r.frames.find(f => f.type === 'result');
    assert.equal(result.subtype, 'error_max_turns');
    assert.equal(result.is_error, true);
    assert.equal(result.num_turns, 2);
    assert.match(result.result, /Stopped after 2 turns/);
  } finally {
    await looping.close();
  }
});
