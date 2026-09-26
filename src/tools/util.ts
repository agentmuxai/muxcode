// Shared helpers for the built-in tools: argument checking (models, small
// local ones especially, send numbers as strings and booleans as "true"),
// path resolution, PATH lookup and output capping.
import { existsSync, statSync } from 'fs';
import path from 'path';

/** A tool failure the model should see as an `is_error` result. */
export class ToolError extends Error {}

type Input = Record<string, unknown>;

export function reqString(input: Input, key: string, { allowEmpty = true } = {}): string {
  const v = input[key];
  if (typeof v !== 'string') throw new ToolError(`"${key}" is required and must be a string`);
  if (!allowEmpty && v === '') throw new ToolError(`"${key}" must not be empty`);
  return v;
}

export function optString(input: Input, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string`);
  return v;
}

export function optNumber(input: Input, key: string): number | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`"${key}" must be a number`);
  return n;
}

export function optBoolean(input: Input, key: string): boolean | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ToolError(`"${key}" must be a boolean`);
}

/** A path from the model: absolute, or relative to the run's cwd. */
export function resolvePath(cwd: string, p: string): string {
  return path.resolve(cwd, p);
}

/**
 * The first `name` executable on PATH (with PATHEXT on Windows), or null.
 * `skip` rejects candidates, e.g. WSL's System32\bash.exe.
 */
export function findOnPath(name: string, skip: (full: string) => boolean = () => false): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase());
      if (skip(full)) continue;
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch { /* unreadable PATH entry */ }
    }
  }
  return null;
}

/**
 * Keeps the first and last `max / 2` characters of a stream without holding
 * all of it in memory, so a runaway command can't exhaust the heap.
 */
export class HeadTail {
  private head = '';
  private tail = '';
  private total = 0;

  constructor(private readonly max: number) {}

  push(s: string) {
    this.total += s.length;
    const half = Math.floor(this.max / 2);
    if (this.head.length < half) {
      const take = half - this.head.length;
      this.head += s.slice(0, take);
      s = s.slice(take);
    }
    if (s) this.tail = (this.tail + s).slice(-half);
  }

  toString(): string {
    const kept = this.head.length + this.tail.length;
    if (this.total <= kept) return this.head + this.tail;
    return `${this.head}\n\n... [${this.total - kept} characters truncated] ...\n\n${this.tail}`;
  }
}

/** Head+tail truncation of an already-collected string. */
export function capText(s: string, max: number): string {
  const ht = new HeadTail(max);
  ht.push(s);
  return ht.toString();
}
