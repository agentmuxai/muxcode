// The stream-json frames AgentMux's translator reads
// (agentmux frontend/app/view/agent/providers/claude-translator.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_MCP_CONFIG, runMuxcode, startFakeAnthropic, startFakeModel, streamEvents } from './helpers.mjs';

const AGENTMUX_ARGS = ['run', '-p', '--dangerously-skip-permissions'];

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('a text reply streams as deltas inside one message, then an assistant frame and a result', async () => {
  const model = await startFakeModel(() => ({ content: 'Hello there' }));
  try {
    const r = await runMuxcode(AGENTMUX_ARGS, { stdin: 'hi', modelUrl: model.url });
    assert.equal(r.code, 0, r.stderr);

    const events = streamEvents(r.frames);
    assert.deepEqual(events.map(e => e.type), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    assert.equal(events[0].message.model, 'gpt-4o');
    assert.equal(events[1].content_block.type, 'text');
    assert.equal(events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join(''), 'Hello there');
    assert.equal(events[5].delta.stop_reason, 'end_turn');
    assert.equal(events[5].usage.output_tokens, 5);

    const assistant = r.frames.filter(f => f.type === 'assistant');
    assert.equal(assistant.length, 1);
    assert.deepEqual(assistant[0].message.content, [{ type: 'text', text: 'Hello there' }]);
    assert.equal(assistant[0].message.stop_reason, 'end_turn');

    const result = r.frames.at(-1);
    assert.equal(result.type, 'result');
    assert.equal(result.subtype, 'success');
    assert.equal(result.is_error, false);
    assert.equal(result.result, 'Hello there');
    assert.equal(result.num_turns, 1);
    assert.deepEqual(result.usage, { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 });
    assert.equal(typeof result.cost_usd, 'number');
    assert.equal(result.total_cost_usd, result.cost_usd);
    assert.equal(typeof result.duration_ms, 'number');
    for (const f of r.frames) assert.equal(typeof f.session_id, 'string');
  } finally {
    await model.close();
  }
});

test('a tool call streams its input, then the result comes back as a user frame', async () => {
  const model = await startFakeModel((_body, n) =>
    n === 0
      ? { content: 'Let me look.', tool_calls: [toolCall('call_1', 'read_thing', { what: 'x' })] }
      : { content: 'It is the thing.' });
  try {
    const r = await runMuxcode(AGENTMUX_ARGS, {
      stdin: 'what is it?',
      modelUrl: model.url,
      files: { '.mcp.json': FIXTURE_MCP_CONFIG },
    });
    assert.equal(r.code, 0, r.stderr);

    const events = streamEvents(r.frames);
    const toolStart = events.find(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
    assert.deepEqual(toolStart.content_block, { type: 'tool_use', id: 'call_1', name: 'read_thing', input: {} });
    const json = events
      .filter(e => e.index === toolStart.index && e.delta?.type === 'input_json_delta')
      .map(e => e.delta.partial_json)
      .join('');
    assert.deepEqual(JSON.parse(json), { what: 'x' });

    // The narration before the tool call must NOT look like the end of the
    // turn: AgentMux ends the turn on a text frame unless stop_reason is "tool_use".
    const assistant = r.frames.filter(f => f.type === 'assistant');
    assert.deepEqual(assistant.map(f => [f.message.content[0].type, f.message.stop_reason]), [
      ['text', 'tool_use'],
      ['tool_use', 'tool_use'],
      ['text', 'end_turn'],
    ]);
    assert.deepEqual(assistant[1].message.content[0].input, { what: 'x' });

    const user = r.frames.find(f => f.type === 'user');
    assert.deepEqual(user.message.content, [{ type: 'tool_result', tool_use_id: 'call_1', content: 'the thing', is_error: false }]);

    // The model got the call and its result back.
    const second = model.requests[1].messages;
    assert.equal(second.at(-2).tool_calls[0].id, 'call_1');
    assert.deepEqual(second.at(-1), { role: 'tool', content: 'the thing', tool_call_id: 'call_1' });

    const result = r.frames.at(-1);
    assert.equal(result.num_turns, 2);
    assert.equal(result.usage.input_tokens, 20);
    assert.equal(result.usage.output_tokens, 10);
  } finally {
    await model.close();
  }
});

test('a failed tool comes back with is_error', async () => {
  const model = await startFakeModel((_body, n) =>
    n === 0 ? { tool_calls: [toolCall('call_x', 'no_such_tool', {})] } : { content: 'ok' });
  try {
    const r = await runMuxcode(AGENTMUX_ARGS, { stdin: 'go', modelUrl: model.url });
    const user = r.frames.find(f => f.type === 'user');
    assert.equal(user.message.content[0].is_error, true);
    assert.match(user.message.content[0].content, /not found/);
  } finally {
    await model.close();
  }
});

test('reasoning streams as thinking deltas', async () => {
  const model = await startFakeModel(() => ({ reasoning_content: 'Consider it.', content: 'Answer.' }));
  try {
    const r = await runMuxcode(AGENTMUX_ARGS, { stdin: 'think', modelUrl: model.url });
    const events = streamEvents(r.frames);
    assert.equal(events.find(e => e.type === 'content_block_start').content_block.type, 'thinking');
    assert.equal(events.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking).join(''), 'Consider it.');
    assert.equal(r.frames.at(-1).result, 'Answer.');
  } finally {
    await model.close();
  }
});

test('an API error ends with an error result carrying the HTTP status', async () => {
  const model = await startFakeModel(() => ({ status: 400, error: 'bad request from fake' }));
  try {
    const r = await runMuxcode(AGENTMUX_ARGS, { stdin: 'hi', modelUrl: model.url });
    assert.equal(r.code, 1);
    const result = r.frames.at(-1);
    assert.equal(result.subtype, 'error_during_execution');
    assert.equal(result.is_error, true);
    assert.equal(result.api_error_status, 400);
    assert.match(result.result, /bad request from fake/);
  } finally {
    await model.close();
  }
});

test('--effort sets reasoning_effort (and drops temperature) for OpenAI', async () => {
  const model = await startFakeModel();
  try {
    await runMuxcode([...AGENTMUX_ARGS, '--effort', 'high'], { stdin: 'hi', modelUrl: model.url });
    assert.equal(model.requests[0].reasoning_effort, 'high');
    assert.equal(model.requests[0].temperature, undefined);
  } finally {
    await model.close();
  }
});

test('the Anthropic backend streams its events, and sends thinking back with its signature', async () => {
  const api = await startFakeAnthropic((_body, n) =>
    n === 0
      ? { thinking: 'Plan it.', text: 'Looking.', toolUse: { id: 'toolu_1', name: 'read_thing', input: { what: 'y' } } }
      : { text: 'Done.' });
  try {
    const r = await runMuxcode([...AGENTMUX_ARGS, '--effort', 'low'], {
      stdin: 'go',
      env: { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: api.url },
      files: { '.mcp.json': FIXTURE_MCP_CONFIG },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(api.requests[0].thinking, { type: 'enabled', budget_tokens: 2048 });

    const events = streamEvents(r.frames);
    assert.deepEqual(events.filter(e => e.type === 'content_block_start').map(e => e.content_block.type),
      ['thinking', 'text', 'tool_use', 'text']);
    assert.equal(events.find(e => e.type === 'message_start').message.usage.cache_read_input_tokens, 100);

    const assistant = r.frames.filter(f => f.type === 'assistant');
    assert.deepEqual(assistant.map(f => [f.message.content[0].type, f.message.stop_reason]), [
      ['thinking', 'tool_use'], ['text', 'tool_use'], ['tool_use', 'tool_use'], ['text', 'end_turn'],
    ]);

    // The second request carries the first turn's blocks back, thinking included.
    const replayed = api.requests[1].messages.find(m => m.role === 'assistant').content;
    assert.deepEqual(replayed[0], { type: 'thinking', thinking: 'Plan it.', signature: 'sig' });
    const toolResult = api.requests[1].messages.at(-1).content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.equal(toolResult.tool_use_id, 'toolu_1');

    const result = r.frames.at(-1);
    assert.equal(result.usage.cache_read_input_tokens, 200);
    assert.equal(result.usage.cache_creation_input_tokens, 8);
    assert.ok(result.cost_usd > 0, 'claude-sonnet-4-6 has a list price');
  } finally {
    await api.close();
  }
});
