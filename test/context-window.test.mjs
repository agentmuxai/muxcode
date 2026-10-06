// The result frame reports the model's context window the way Claude Code
// does (`modelUsage[<model>].contextWindow`), so AgentMux's context meter
// shows "tokens / window" for a muxcode pane instead of "tokens ctx".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StreamJsonEmitter } from '../dist/emit/stream-json.js';

const usage = { inputTokens: 1200, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const totals = { usage, costUsd: 0, numTurns: 1, durationApiMs: 10 };

/** The frames `run` writes to stdout. */
function capture(fn) {
  const frames = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) frames.push(JSON.parse(line));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = write;
  }
  return frames;
}

test('no window known (a remote backend): no modelUsage', () => {
  const frames = capture(() => {
    const e = new StreamJsonEmitter('s1');
    e.messageStart('m1', 'gpt-4o', usage);
    e.done('ok', totals);
  });
  const result = frames.find(f => f.type === 'result');
  assert.equal(result.modelUsage, undefined);
});

test('a local model reports its window under its own id and the id message_start carried', () => {
  const frames = capture(() => {
    const e = new StreamJsonEmitter('s1');
    e.setContextWindow('qwen2.5-coder-7b-q4', 32768);
    e.messageStart('m1', 'served-model-alias', usage);
    e.done('ok', totals);
  });
  const result = frames.find(f => f.type === 'result');
  assert.deepEqual(result.modelUsage, {
    'qwen2.5-coder-7b-q4': { contextWindow: 32768 },
    'served-model-alias': { contextWindow: 32768 },
  });
});

test('an error result reports it too', () => {
  const frames = capture(() => {
    const e = new StreamJsonEmitter('s1');
    e.setContextWindow('local-model', 4096);
    e.error('boom');
  });
  const result = frames.find(f => f.type === 'result');
  assert.equal(result.is_error, true);
  assert.deepEqual(result.modelUsage, { 'local-model': { contextWindow: 4096 } });
});
