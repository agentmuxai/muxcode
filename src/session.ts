// Sessions: each conversation is an append-only JSONL file, so `--resume <id>`
// continues it and a crash loses at most the step in progress. AgentMux runs
// one process per turn and passes the id back with `--resume`, so without this
// every turn started from scratch.
//
// Layout: <config root>/sessions/<id>.jsonl, where the config root is
// MUXCODE_CONFIG_DIR (AgentMux sets it per agent) or ~/.mux. The first line is
// a `meta` record; every later line is one `message`.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Message } from './types.js';

export function configRoot(): string {
  return process.env.MUXCODE_CONFIG_DIR || path.join(os.homedir(), '.mux');
}

export function sessionsDir(): string {
  return path.join(configRoot(), 'sessions');
}

/** Session ids become file names, so only a safe character set is accepted. */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

export function sessionPath(id: string): string {
  if (!isValidSessionId(id)) throw new Error(`Invalid session id "${id}"`);
  return path.join(sessionsDir(), `${id}.jsonl`);
}

interface MetaLine {
  type: 'meta';
  id: string;
  cwd: string;
  created_at: string;
}

interface MessageLine {
  type: 'message';
  message: Message;
}

/** The conversation so far (without the system prompt, which is rebuilt each run). */
export function loadSession(id: string): Message[] | null {
  const file = sessionPath(id);
  if (!existsSync(file)) return null;
  const messages: Message[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec: MetaLine | MessageLine;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn last line from a crash
    }
    if (rec.type === 'message' && rec.message.role !== 'system') messages.push(rec.message);
  }
  return dropDanglingToolCall(messages);
}

/**
 * An interrupted run can leave an assistant tool call without all of its
 * results. Providers reject that history, so drop the trailing incomplete
 * exchange.
 */
function dropDanglingToolCall(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set(
        messages.slice(i + 1).filter(r => r.role === 'tool').map(r => r.tool_call_id ?? r.tool_use_id),
      );
      return m.tool_calls.every(tc => answered.has(tc.id)) ? messages : messages.slice(0, i);
    }
    if (m.role === 'user') return messages;
  }
  return messages;
}

/** The most recently updated session started in `cwd`, if any. */
export function latestSessionFor(cwd: string): string | null {
  const dir = sessionsDir();
  if (!existsSync(dir)) return null;
  let best: { id: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let meta: MetaLine | undefined;
    try {
      meta = JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]);
    } catch {
      continue;
    }
    if (meta?.type !== 'meta' || path.resolve(meta.cwd) !== path.resolve(cwd)) continue;
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { id: meta.id, mtime };
  }
  return best?.id ?? null;
}

/** Appends messages to a session file as the run produces them. */
export class SessionWriter {
  private file: string;

  constructor(readonly id: string, cwd: string) {
    this.file = sessionPath(id);
    if (!existsSync(this.file)) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const meta: MetaLine = { type: 'meta', id, cwd, created_at: new Date().toISOString() };
      appendFileSync(this.file, JSON.stringify(meta) + '\n', { mode: 0o600 });
    }
  }

  append(message: Message): void {
    const line: MessageLine = { type: 'message', message };
    appendFileSync(this.file, JSON.stringify(line) + '\n');
  }
}
