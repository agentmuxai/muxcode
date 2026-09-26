// Test helpers: a fake OpenAI-compatible model server, and a way to run the
// built CLI the way AgentMux does (argv plus a prompt on stdin).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
      const message = { role: 'assistant', content: null, ...reply(body, n) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        id: `chatcmpl-${n}`,
        object: 'chat.completion',
        model: body.model ?? 'fake',
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
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

/**
 * Run `bin/muxcode.js` in an empty temp dir with an isolated home (so no real
 * `.mcp.json` or config is picked up), pointed at `modelUrl`.
 */
export function runMuxcode(args, { stdin = '', modelUrl, env = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muxcode-test-'));
  const childEnv = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MUX_MCP_CONFIG', 'MUXCODE_CONFIG_DIR']) {
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

/** The text of the last user message the model received. */
export function lastUserText(request) {
  const users = request.messages.filter(m => m.role === 'user');
  const last = users[users.length - 1];
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}
