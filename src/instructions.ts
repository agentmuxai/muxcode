// Instruction files (CLAUDE.md, AGENTS.md), read by Claude Code's rules so the
// soul, memory and skills AgentMux writes into an agent's CLAUDE.md reach the
// model. Sent as the first user message, not in the system prompt, so the
// system prompt stays byte-stable for prompt caching (as Claude Code does).
import { readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import os from 'os';
import path from 'path';

/** Total budget for instruction text (Codex's project_doc_max_bytes). */
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;
/** Imports nest at most this deep (Claude Code's limit). */
const MAX_IMPORT_DEPTH = 4;
/** Larger files are skipped: the whole budget is 32 KiB anyway. */
const MAX_FILE_BYTES = 1024 * 1024;

const USER_DESC = "user's private global instructions for all projects";
const PROJECT_DESC = 'project instructions, checked into the codebase';
const LOCAL_DESC = "user's private project instructions, not checked in";

interface Source {
  file: string;
  description: string;
  text: string;
}

/** Set `MUXCODE_DISABLE_INSTRUCTIONS=1` to send no instruction files. */
export function instructionsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MUXCODE_DISABLE_INSTRUCTIONS?.trim().toLowerCase();
  return !!v && v !== '0' && v !== 'false';
}

/**
 * The instruction files that apply in `cwd`, as one user message, or
 * undefined when there are none. Broadest first:
 *
 * 1. `~/.claude/CLAUDE.md`, then `~/.claude/rules/**\/*.md`.
 * 2. Each directory from the filesystem root down to `cwd`, as Claude Code
 *    walks (so an AgentMux agent in `~/.agentmux/agents/<agent>/` also gets
 *    `~/.agentmux/agents/CLAUDE.md`): `AGENTS.md`, `CLAUDE.md`,
 *    `.claude/CLAUDE.md`, `CLAUDE.local.md`.
 * 3. Rules come from the project only, not every ancestor: the project is the
 *    nearest ancestor of `cwd` holding `.git`, or `cwd` itself if none, and
 *    its `.claude/rules/**\/*.md` follow its own files. Rules with a `paths:`
 *    frontmatter are skipped: Claude loads them only once a matching file is
 *    read, and Mux Code has no hook for that yet.
 *
 * AGENTS.md is read alongside CLAUDE.md (Claude reads it only when there is
 * no CLAUDE.md, and AgentMux always writes one). Every file is included once,
 * even if it is also imported or symlinked. An import in a directory's file
 * must stay inside that directory's tree or the project's; user-level files
 * may import anything. See `expandImports` and `capped` for imports and the
 * size cap.
 */
export function loadInstructions(cwd: string = process.cwd(), home: string = os.homedir()): string | undefined {
  const seen = new Set<string>();
  const sources: Source[] = [];
  const add = (file: string, description: string, importRoots?: string[], rule = false) => {
    const key = fileKey(file);
    if (!key || seen.has(key)) return;
    let raw = readText(file);
    if (raw === undefined) return;
    if (rule) {
      const rest = ruleBody(raw);
      if (rest === undefined) return;
      raw = rest;
    }
    seen.add(key);
    const text = expandImports(stripHtmlComments(raw), file, home, importRoots, seen, 0).trim();
    if (text) sources.push({ file, description, text });
  };

  const userDir = path.join(home, '.claude');
  add(path.join(userDir, 'CLAUDE.md'), USER_DESC);
  for (const f of ruleFiles(path.join(userDir, 'rules'))) add(f, USER_DESC, undefined, true);

  const project = projectRoot(cwd);
  const projectKey = fileKey(project);
  for (const dir of ancestorsOf(cwd)) {
    const dirKey = fileKey(dir);
    const roots = [dirKey, projectKey].filter((k): k is string => !!k);
    add(path.join(dir, 'AGENTS.md'), PROJECT_DESC, roots);
    add(path.join(dir, 'CLAUDE.md'), PROJECT_DESC, roots);
    add(path.join(dir, '.claude', 'CLAUDE.md'), PROJECT_DESC, roots);
    add(path.join(dir, 'CLAUDE.local.md'), LOCAL_DESC, roots);
    if (dir === project) {
      for (const f of ruleFiles(path.join(project, '.claude', 'rules'))) add(f, PROJECT_DESC, roots, true);
    }
  }

  if (sources.length === 0) return undefined;
  return render(capped(sources, INSTRUCTIONS_MAX_BYTES));
}

function render({ kept, omitted }: { kept: Source[]; omitted: string[] }): string {
  const parts = [
    '<system-reminder>',
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions. '
      + 'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
  ];
  if (omitted.length) {
    parts.push(`[Instructions exceeded ${INSTRUCTIONS_MAX_BYTES / 1024} KiB; omitted: ${omitted.join(', ')}]`);
  }
  for (const s of kept) parts.push(`Contents of ${s.file} (${s.description}):\n\n${s.text}`);
  parts.push('</system-reminder>');
  return parts.join('\n\n');
}

/**
 * Keep the most specific files: fill the budget from the last (nearest the
 * cwd, e.g. AgentMux's CLAUDE.md) backwards. The first file that doesn't fit
 * keeps its head, with a marker; every broader file is omitted and named.
 */
function capped(sources: Source[], budget: number): { kept: Source[]; omitted: string[] } {
  const kept: Source[] = [];
  let i = sources.length - 1;
  for (; i >= 0 && budget > 0; i--) {
    const s = sources[i];
    const size = Buffer.byteLength(s.text);
    if (size <= budget) {
      kept.unshift(s);
      budget -= size;
    } else {
      kept.unshift({ ...s, text: `${headBytes(s.text, budget)}\n\n[... truncated: ${size - budget} more bytes of ${s.file} not shown]` });
      budget = 0;
    }
  }
  return { kept, omitted: sources.slice(0, i + 1).map(s => s.file) };
}

/** The first `n` bytes of `s`, without splitting a character. */
function headBytes(s: string, n: number): string {
  let head = Buffer.from(s).subarray(0, n).toString('utf8');
  // A cut mid-character decodes to U+FFFD replacement characters; drop them.
  while (head.charCodeAt(head.length - 1) === 0xfffd) head = head.slice(0, -1);
  return head;
}

/** The nearest ancestor of `cwd` (inclusive) holding `.git` (a dir, or a worktree's file), else `cwd`. */
function projectRoot(cwd: string): string {
  const start = path.resolve(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

/** `cwd` and every ancestor, filesystem root first. */
function ancestorsOf(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (path.dirname(dir) === dir) return dirs;
  }
}

/** `*.md` under a rules dir, recursively, in a stable order. */
function ruleFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map(e => path.join(e.parentPath, e.name))
    .sort();
}

/** A rule without its frontmatter, or undefined if the rule is path-scoped. */
function ruleBody(raw: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return raw;
  if (/^paths[ \t]*:/m.test(m[1])) return undefined;
  return raw.slice(m[0].length);
}

/**
 * Drop block HTML comments (`<!-- ... -->` starting a line, possibly spanning
 * lines), as Claude Code does, except inside code fences.
 */
function stripHtmlComments(text: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let inComment = false;
  for (const line of text.split(/\r?\n/)) {
    if (inComment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      inComment = false;
      const rest = line.slice(end + 3);
      if (rest.trim()) out.push(rest);
      continue;
    }
    const f = fenceMarker(line);
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = undefined;
      out.push(line);
      continue;
    }
    if (f) {
      fence = f;
      out.push(line);
      continue;
    }
    let rest = line;
    let stripped = false;
    while (/^\s*<!--/.test(rest)) {
      stripped = true;
      const body = rest.slice(rest.indexOf('<!--') + 4);
      const end = body.indexOf('-->');
      if (end < 0) {
        inComment = true;
        rest = '';
        break;
      }
      rest = body.slice(end + 3);
    }
    if (!stripped || rest.trim()) out.push(stripped ? rest : line);
  }
  return out.join('\n');
}

/** The fence (``` or ~~~, 3+) a line opens or closes, if any. */
function fenceMarker(line: string): string | undefined {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
}

// `@path` preceded by start-of-line or whitespace; `\ ` escapes a space.
const IMPORT_RE = /(^|\s)@((?:[^\s\\]|\\ )+)/g;

/**
 * Replace each `@path` import (outside code spans and fences) with the file's
 * own expanded content. Paths are relative to the importing file, absolute,
 * or `~/`-relative. An import is left as written when the file is missing,
 * not text, already included, or would nest deeper than 4 levels. Unless
 * `importRoots` is undefined (user-level files), the target must lie inside
 * one of them: Claude Code asks before following an import from outside the
 * project, and a one-shot run has no one to ask.
 */
function expandImports(
  text: string, file: string, home: string, importRoots: string[] | undefined,
  seen: Set<string>, depth: number,
): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const f = fenceMarker(line);
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = undefined;
      out.push(line);
      continue;
    }
    if (f) {
      fence = f;
      out.push(line);
      continue;
    }
    // Odd segments of a backtick split are code spans; leave them alone.
    out.push(splitCodeSpans(line).map((seg, i) => (i % 2 ? seg : seg.replace(IMPORT_RE, (whole, lead: string, spec: string) => {
      if (depth >= MAX_IMPORT_DEPTH) return whole;
      const target = resolveImport(spec, file, home);
      if (!target) return whole;
      const key = fileKey(target);
      if (!key || seen.has(key)) return whole;
      if (importRoots && !importRoots.some(root => isInside(key, root))) return whole;
      const raw = readText(target);
      if (raw === undefined) return whole;
      seen.add(key);
      const body = expandImports(stripHtmlComments(raw), target, home, importRoots, seen, depth + 1);
      return lead + body.trim();
    }))).join(''));
  }
  return out.join('\n');
}

/** Split a line into alternating [text, code span, text, ...] segments. */
function splitCodeSpans(line: string): string[] {
  const segs: string[] = [];
  let last = 0;
  const re = /(`+)[\s\S]*?(?<!`)\1(?!`)/g;
  for (let m; (m = re.exec(line)); ) {
    segs.push(line.slice(last, m.index), m[0]);
    last = m.index + m[0].length;
  }
  segs.push(line.slice(last));
  return segs;
}

function resolveImport(spec: string, file: string, home: string): string | undefined {
  let p = spec.replace(/\\ /g, ' ').replace(/#.*$/, '');
  if (!p || p.startsWith('@') || /^[#%^&*()]/.test(p)) return undefined;
  if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
  return path.resolve(path.dirname(file), p);
}

/** Text content of a regular file, or undefined (missing, too big, binary, unreadable). */
function readText(file: string): string | undefined {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    const text = readFileSync(file, 'utf8');
    if (text.includes('\0')) return undefined;
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM
  } catch {
    return undefined;
  }
}

/** Identity of a file across symlinks and (on Windows/macOS) letter case, or undefined if missing. */
function fileKey(file: string): string | undefined {
  try {
    const real = realpathSync.native(file);
    return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
  } catch {
    return undefined;
  }
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
