// Grep runs ripgrep when `rg` is on PATH (fast, and honours every .gitignore
// the way Claude Code's Grep does). Without it, a JS fallback walks the tree:
// it skips .git, node_modules and the root .gitignore's simple patterns, and
// uses JavaScript regex syntax, which agrees with ripgrep's for the patterns
// models usually write.
import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import type { BuiltinTool } from './types.js';
import { capText, findOnPath, optBoolean, optNumber, optString, reqString, resolvePath, ToolError } from './util.js';

export type GrepMode = 'files_with_matches' | 'content' | 'count';

export interface GrepOptions {
  pattern: string;
  /** Absolute file or directory to search. */
  root: string;
  mode: GrepMode;
  glob?: string;
  type?: string;
  ignoreCase: boolean;
  lineNumbers: boolean;
  before: number;
  after: number;
  multiline: boolean;
  /** Stop collecting after this many output lines. */
  limit?: number;
}

const MAX_OUTPUT_CHARS = 30_000;
/** Without head_limit, stop collecting after this many lines (the result is capped anyway). */
const MAX_LINES = 20_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
/** The JS fallback's time budget; a runaway regex is stopped here. */
export const JS_FALLBACK_TIMEOUT_MS = 60_000;

let rgPath: string | null | undefined;

export const grepTool: BuiltinTool = {
  spec: {
    name: 'Grep',
    description:
      'Searches file contents with a regular expression (ripgrep syntax). output_mode: "files_with_matches" ' +
      '(default) lists matching files, newest first; "content" shows matching lines (with -n line numbers, ' +
      '-A/-B/-C context); "count" shows matches per file. Filter files with glob (e.g. "*.ts", "src/**/*.tsx") ' +
      'or type (e.g. "js", "py"). head_limit keeps the first N lines or entries. Use this instead of grep or rg in Bash.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regular expression to search for in file contents' },
        path: { type: 'string', description: 'File or directory to search in (default: the working directory)' },
        glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output mode: "content" shows matching lines, "files_with_matches" (default) shows file paths, "count" shows match counts',
        },
        '-i': { type: 'boolean', description: 'Case insensitive search' },
        '-n': { type: 'boolean', description: 'Show line numbers in output (content mode; default true)' },
        '-A': { type: 'number', description: 'Number of lines to show after each match (content mode)' },
        '-B': { type: 'number', description: 'Number of lines to show before each match (content mode)' },
        '-C': { type: 'number', description: 'Number of lines to show before and after each match (content mode)' },
        type: { type: 'string', description: 'File type to search (e.g. js, py, rust, go)' },
        head_limit: { type: 'number', description: 'Limit output to the first N lines or entries' },
        multiline: { type: 'boolean', description: 'Let patterns span lines, with . matching newlines (default false)' },
      },
      required: ['pattern'],
    },
    _serverId: '',
    readOnly: true,
    builtin: true,
  },

  async run(input, ctx) {
    const mode = (optString(input, 'output_mode') ?? 'files_with_matches') as GrepMode;
    if (!['files_with_matches', 'content', 'count'].includes(mode)) {
      throw new ToolError('output_mode must be "files_with_matches", "content" or "count"');
    }
    const context = optNumber(input, '-C') ?? 0;
    const headLimit = optNumber(input, 'head_limit');
    const opts: GrepOptions = {
      pattern: reqString(input, 'pattern', { allowEmpty: false }),
      root: resolvePath(ctx.cwd, optString(input, 'path') ?? '.'),
      mode,
      glob: optString(input, 'glob'),
      type: optString(input, 'type'),
      ignoreCase: optBoolean(input, '-i') ?? false,
      lineNumbers: optBoolean(input, '-n') ?? true,
      before: Math.max(0, optNumber(input, '-B') ?? context),
      after: Math.max(0, optNumber(input, '-A') ?? context),
      multiline: optBoolean(input, 'multiline') ?? false,
      limit: headLimit && headLimit > 0 ? Math.floor(headLimit) : undefined,
    };
    try {
      await stat(opts.root);
    } catch {
      throw new ToolError(`Path does not exist: ${opts.root}`);
    }

    if (rgPath === undefined) rgPath = findOnPath('rg');
    // files_with_matches lists the newest files first: collect them all, sort,
    // then apply head_limit (format), or the limit would keep arbitrary files.
    const collect = opts.mode === 'files_with_matches' ? { ...opts, limit: undefined } : opts;
    const lines = rgPath
      ? await ripgrep(rgPath, collect, ctx.signal)
      : await grepJsGuarded(collect, { signal: ctx.signal });
    return format(lines, opts);
  },
};

async function format(lines: string[], opts: GrepOptions): Promise<string> {
  if (opts.mode === 'files_with_matches') {
    // Newest first, as Claude Code's Grep lists them; head_limit applies after,
    // so it keeps the newest files rather than whichever were found first.
    const withTimes = await Promise.all(lines.map(async f => ({ f, t: await stat(f).then(s => s.mtimeMs, () => 0) })));
    withTimes.sort((a, b) => b.t - a.t || a.f.localeCompare(b.f));
    lines = withTimes.map(x => x.f);
  }
  if (opts.limit !== undefined) lines = lines.slice(0, opts.limit);
  // A context-group separator left dangling by the limit.
  if (lines.at(-1) === '--') lines = lines.slice(0, -1);
  if (lines.length === 0) return opts.mode === 'files_with_matches' ? 'No files found' : 'No matches found';

  if (opts.mode === 'files_with_matches') {
    return capText(`Found ${lines.length} file${lines.length === 1 ? '' : 's'}\n${lines.join('\n')}`, MAX_OUTPUT_CHARS);
  }
  if (opts.mode === 'count') {
    const total = lines.reduce((sum, l) => sum + (Number(l.slice(l.lastIndexOf(':') + 1)) || 0), 0);
    return capText(`${lines.join('\n')}\n\nFound ${total} total occurrence${total === 1 ? '' : 's'} across ${lines.length} file${lines.length === 1 ? '' : 's'}.`, MAX_OUTPUT_CHARS);
  }
  return capText(lines.join('\n'), MAX_OUTPUT_CHARS);
}

function ripgrep(rg: string, opts: GrepOptions, signal?: AbortSignal): Promise<string[]> {
  // Hidden files are searched, .git and node_modules are not, and .gitignore
  // applies even outside a git repo, matching the JS fallback.
  const args = [
    '--hidden', '--glob', '!.git', '--glob', '!node_modules', '--no-require-git',
    '--with-filename', '--color', 'never', '--max-columns', '500',
  ];
  if (opts.mode === 'files_with_matches') args.push('--files-with-matches');
  else if (opts.mode === 'count') args.push('--count');
  else {
    args.push(opts.lineNumbers ? '--line-number' : '--no-line-number');
    if (opts.before) args.push('-B', String(opts.before));
    if (opts.after) args.push('-A', String(opts.after));
  }
  if (opts.ignoreCase) args.push('--ignore-case');
  if (opts.multiline) args.push('--multiline', '--multiline-dotall');
  if (opts.glob) args.push('--glob', opts.glob);
  if (opts.type) args.push('--type', opts.type);
  // -e so a pattern starting with "-" isn't read as a flag.
  args.push('-e', opts.pattern, '--', opts.root);

  const limit = opts.limit ?? MAX_LINES;
  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    const lines: string[] = [];
    let partial = '';
    let stderr = '';
    let full = false;
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (full) return;
      const parts = (partial + d).split(/\r?\n/);
      partial = parts.pop() ?? '';
      for (const p of parts) {
        lines.push(p);
        if (lines.length >= limit) {
          full = true;
          child.kill();
          break;
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', err => reject(new ToolError(
      signal?.aborted ? 'Grep was interrupted.' : `Could not run ripgrep: ${err.message}`,
    )));
    child.on('close', code => {
      if (!full && partial) lines.push(partial);
      // 1 = no matches; 2 = an error, though matches found elsewhere still count.
      if (code === 2 && lines.length === 0 && !full) reject(new ToolError(stderr.trim() || 'ripgrep failed'));
      else resolve(lines);
    });
  });
}

/**
 * The JS fallback, run in a worker (grep-worker.ts) so a catastrophically
 * backtracking pattern can't freeze the CLI: the worker is terminated after
 * `timeoutMs` or when the run is interrupted.
 */
export function grepJsGuarded(
  opts: GrepOptions,
  { signal, timeoutMs = JS_FALLBACK_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string[]> {
  if (signal?.aborted) return Promise.reject(new ToolError('Grep was interrupted.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./grep-worker.js', import.meta.url), { workerData: opts });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new ToolError(
      `Grep stopped after ${Math.round(timeoutMs / 1000)} s: the pattern may backtrack catastrophically. ` +
      'Simplify it (avoid nested quantifiers like (a+)+), narrow path/glob, or install ripgrep.',
    ))), timeoutMs);
    const onAbort = () => finish(() => reject(new ToolError('Grep was interrupted.')));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (m: { ok: boolean; lines?: string[]; message?: string }) =>
      finish(() => (m.ok ? resolve(m.lines ?? []) : reject(new ToolError(m.message ?? 'Grep failed')))));
    worker.once('error', err => finish(() => reject(new ToolError(`Grep failed: ${err.message}`))));
  });
}

/** The fallback when ripgrep isn't installed; output in ripgrep's shapes. */
export async function grepJs(opts: GrepOptions): Promise<string[]> {
  let regex: RegExp;
  try {
    regex = new RegExp(opts.pattern, (opts.ignoreCase ? 'i' : '') + (opts.multiline ? 'gms' : ''));
  } catch (err) {
    throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
  }
  const limit = opts.limit ?? MAX_LINES;
  const out: string[] = [];

  for await (const file of walk(opts)) {
    let buf: Buffer;
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) continue;
      buf = await readFile(file);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) continue;
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();

    // Which lines match (for multiline, every line a match spans).
    const hits = new Set<number>();
    let count = 0;
    if (opts.multiline) {
      const starts = lineStarts(text);
      for (const m of text.matchAll(regex)) {
        count++;
        const first = lineOf(starts, m.index);
        const last = lineOf(starts, m.index + Math.max(0, m[0].length - 1));
        for (let i = first; i <= last; i++) hits.add(i);
      }
    } else {
      lines.forEach((line, i) => {
        if (regex.test(line)) {
          hits.add(i);
          count++;
        }
      });
    }
    if (count === 0) continue;

    if (opts.mode === 'files_with_matches') out.push(file);
    else if (opts.mode === 'count') out.push(`${file}:${count}`);
    else out.push(...contentLines(file, lines, hits, opts));
    if (out.length >= limit) break;
  }
  return out;
}

/** Matching lines with context, formatted like ripgrep: `path:n:text`, `path-n-text`, `--` between groups. */
function contentLines(file: string, lines: string[], hits: Set<number>, opts: GrepOptions): string[] {
  const shown = new Set<number>();
  for (const i of hits) {
    for (let j = Math.max(0, i - opts.before); j <= Math.min(lines.length - 1, i + opts.after); j++) shown.add(j);
  }
  const out: string[] = [];
  let prev = -2;
  for (const i of [...shown].sort((a, b) => a - b)) {
    if (prev >= 0 && i !== prev + 1 && (opts.before || opts.after)) out.push('--');
    const sep = hits.has(i) ? ':' : '-';
    out.push(`${file}${sep}${opts.lineNumbers ? `${i + 1}${sep}` : ''}${lines[i].slice(0, 500)}`);
    prev = i;
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** ripgrep's `--type` names for the common languages; anything else is taken as a file extension. */
const TYPE_EXTENSIONS: Record<string, string[]> = {
  js: ['js', 'jsx', 'mjs', 'cjs', 'vue'],
  ts: ['ts', 'tsx', 'mts', 'cts'],
  py: ['py', 'pyi'],
  rust: ['rs'],
  go: ['go'],
  java: ['java', 'jsp'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'h'],
  md: ['md', 'markdown', 'mdx'],
  markdown: ['md', 'markdown', 'mdx'],
  json: ['json'],
  yaml: ['yaml', 'yml'],
  sh: ['sh', 'bash', 'zsh'],
  css: ['css', 'scss', 'sass', 'less'],
  html: ['html', 'htm'],
};

async function* walk(opts: GrepOptions): AsyncGenerator<string> {
  const info = await stat(opts.root);
  if (info.isFile()) {
    yield opts.root;
    return;
  }
  const ignored = await loadGitignore(opts.root);
  const exts = opts.type ? new Set(TYPE_EXTENSIONS[opts.type] ?? [opts.type]) : undefined;

  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(path.join(opts.root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (ignored(rel, e.name, e.isDirectory())) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (exts && !exts.has(path.extname(e.name).slice(1).toLowerCase())) continue;
      if (opts.glob && !globMatches(opts.glob, rel, e.name)) continue;
      yield path.join(opts.root, rel);
    }
  }
}

/** Like ripgrep's --glob: a pattern without "/" matches the file name, else the path. */
function globMatches(glob: string, rel: string, name: string): boolean {
  return path.matchesGlob(glob.includes('/') ? rel : name, glob);
}

/** The root .gitignore's plain patterns (no negation); nested .gitignore files are not read. */
async function loadGitignore(root: string): Promise<(rel: string, name: string, isDir: boolean) => boolean> {
  let text = '';
  try {
    text = await readFile(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return () => false;
  }
  const rules = text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(l => {
      const dirOnly = l.endsWith('/');
      let p = dirOnly ? l.slice(0, -1) : l;
      const anchored = p.startsWith('/') || p.includes('/');
      if (p.startsWith('/')) p = p.slice(1);
      return { p, dirOnly, anchored };
    });
  return (rel, name, isDir) => rules.some(r =>
    (!r.dirOnly || isDir) && (r.anchored ? path.matchesGlob(rel, r.p) : path.matchesGlob(name, r.p)));
}
