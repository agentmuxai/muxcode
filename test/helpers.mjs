// Test helpers: a fake OpenAI-compatible model server, and a way to run the
// built CLI the way AgentMux does (argv plus a prompt on stdin).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'muxcode.js');

/**
 * Start a fake `/v1/chat/completions` server. `reply(body, n)` returns the
 * assistant message for the n-th request (0-based); every request body is
 * recorded in `requests`.
 */
export async function startFakeModel(reply = () => ({ content: 'done' })) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      const n = requests.length;
      requests.push(body);
      const r = reply(body, n);
      if (r.status) {
        res.statusCode = r.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { message: r.error ?? 'fake error', type: 'invalid_request_error' } }));
        return;
      }
      const message = { role: 'assistant', content: null, ...r };
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      const finish = message.tool_calls ? 'tool_calls' : 'stop';
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          id: `chatcmpl-${n}`, object: 'chat.completion', model: body.model ?? 'fake',
          choices: [{ index: 0, message, finish_reason: finish }], usage,
        }));
        return;
      }
      // Streamed: each piece of the message split across chunks, as real servers do.
      const base = { id: `chatcmpl-${n}`, object: 'chat.completion.chunk', model: body.model ?? 'fake' };
      const chunk = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] });
      const out = [chunk({ role: 'assistant' })];
      for (const piece of halves(message.reasoning_content)) out.push(chunk({ reasoning_content: piece }));
      for (const piece of halves(message.content)) out.push(chunk({ content: piece }));
      (message.tool_calls ?? []).forEach((tc, index) => {
        out.push(chunk({ tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }));
        for (const piece of halves(tc.function.arguments)) {
          out.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
        }
      });
      out.push(chunk({}, finish));
      out.push({ ...base, choices: [], usage });
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(out.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function halves(s) {
  if (!s) return [];
  const mid = Math.ceil(s.length / 2);
  return mid < s.length ? [s.slice(0, mid), s.slice(mid)] : [s];
}

/**
 * A fake Anthropic Messages API that streams one scripted response per
 * request: `reply(body, n)` returns `{ text?, thinking?, toolUse?: {id, name, input} }`.
 */
export async function startFakeAnthropic(reply = () => ({ text: 'done' })) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      const n = requests.length;
      requests.push(body);
      const r = reply(body, n);
      const id = `msg_${n}`;
      const events = [];
      const ev = (type, payload) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      const usage = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 4, cache_read_input_tokens: 100 };
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      let index = 0;
      if (r.thinking) {
        ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
        ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: r.thinking } });
        ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig' } });
        ev('content_block_stop', { index });
        index++;
      }
      if (r.text) {
        ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (const piece of halves(r.text)) ev('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
        ev('content_block_stop', { index });
        index++;
      }
      if (r.toolUse) {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: r.toolUse.id, name: r.toolUse.name, input: {} } });
        for (const piece of halves(JSON.stringify(r.toolUse.input))) {
          ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } });
        }
        ev('content_block_stop', { index });
      }
      ev('message_delta', { delta: { stop_reason: r.toolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
      ev('message_stop', {});
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(events.join(''));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** The `stream_event` inner events, in order. */
export function streamEvents(frames) {
  return frames.filter(f => f.type === 'stream_event').map(f => f.event);
}

/**
 * Run `bin/muxcode.js` in an empty temp dir with an isolated home (so no real
 * `.mcp.json` or config is picked up), pointed at `modelUrl`.
 */
export function runMuxcode(args, { stdin = '', modelUrl, env = {}, files = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muxcode-test-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  const childEnv = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MUX_MCP_CONFIG', 'MUXCODE_CONFIG_DIR']) {
    delete childEnv[k];
  }
  Object.assign(childEnv, {
    HOME: dir,
    USERPROFILE: dir,
    ...(modelUrl ? { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: modelUrl } : {}),
    ...env,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: dir, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', reject);
    child.on('close', code => {
      rmSync(dir, { recursive: true, force: true });
      const frames = stdout
        .split('\n')
        .filter(line => line.trim().startsWith('{'))
        .map(line => JSON.parse(line));
      resolve({ code, stdout, stderr, frames });
    });
    child.stdin.end(stdin);
  });
}

/** A `.mcp.json` that starts the fixture MCP server (one read-only tool, one not). */
export const FIXTURE_MCP_CONFIG = {
  mcpServers: {
    fixture: { command: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'mcp-server.mjs')] },
  },
};

/** The text of the last user message the model received. */
export function lastUserText(request) {
  const users = request.messages.filter(m => m.role === 'user');
  const last = users[users.length - 1];
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}
