import { readFile, stat, writeFile } from 'fs/promises';
import type { BuiltinTool } from './types.js';
import { optBoolean, reqString, resolvePath, ToolError } from './util.js';

const SNIPPET_CONTEXT = 4;
const SNIPPET_MAX_LINES = 40;

export const editTool: BuiltinTool = {
  spec: {
    name: 'Edit',
    description:
      'Performs an exact string replacement in a file. old_string must match the file exactly (including ' +
      'whitespace and indentation) and occur exactly once, unless replace_all is true, in which case every ' +
      'occurrence is replaced. Read the file first so old_string is copied from its current contents. ' +
      'Line endings follow the file (CRLF files stay CRLF). To create a new file, use Write.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The path to the file to modify (absolute, or relative to the working directory)' },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string)' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default false)', default: false },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    _serverId: '',
    builtin: true,
  },

  async run(input, ctx) {
    const filePath = resolvePath(ctx.cwd, reqString(input, 'file_path', { allowEmpty: false }));
    let oldString = reqString(input, 'old_string');
    let newString = reqString(input, 'new_string');
    const replaceAll = optBoolean(input, 'replace_all') ?? false;
    if (oldString === '') throw new ToolError('old_string must not be empty. To create a file, use Write.');
    if (oldString === newString) throw new ToolError('old_string and new_string are identical; there is nothing to change.');

    let raw: string;
    try {
      if ((await stat(filePath)).isDirectory()) throw new ToolError(`${filePath} is a directory, not a file.`);
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`File does not exist: ${filePath}. To create it, use Write.`);
    }

    // Keep a UTF-8 BOM, and match in the file's own line endings: models
    // almost always send LF, even for a CRLF file.
    const bom = raw.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
    const text = bom ? raw.slice(1) : raw;
    const eol = dominantEol(text);
    oldString = oldString.replace(/\r?\n/g, eol);
    newString = newString.replace(/\r?\n/g, eol);
    if (oldString === newString) throw new ToolError('old_string and new_string differ only in line endings; there is nothing to change.');

    const positions = occurrences(text, oldString);
    if (positions.length === 0) {
      throw new ToolError(
        `old_string was not found in ${filePath}. It must match the file exactly, including whitespace and ` +
        'indentation; Read the file to check its current contents.',
      );
    }
    if (positions.length > 1 && !replaceAll) {
      throw new ToolError(
        `old_string occurs ${positions.length} times in ${filePath}. Include more surrounding context to make it ` +
        'unique, or set replace_all to true to replace every occurrence.',
      );
    }

    // Splice by position (not String.replace, which would expand `$&` etc. in new_string).
    const targets = replaceAll ? positions : [positions[0]];
    let updated = '';
    let last = 0;
    for (const pos of targets) {
      updated += text.slice(last, pos) + newString;
      last = pos + oldString.length;
    }
    updated += text.slice(last);
    await writeFile(filePath, bom + updated, 'utf8');

    const firstStart = targets[0];
    const summary = targets.length > 1
      ? `The file ${filePath} has been updated: ${targets.length} occurrences replaced.`
      : `The file ${filePath} has been updated.`;
    return `${summary} A snippet of the edited file (cat -n):\n${snippet(updated, firstStart, newString.length)}`;
  },
};

/** "\r\n" if most of the file's line breaks are CRLF, else "\n". */
function dominantEol(text: string): string {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** The edited region plus a few lines of context, numbered like Read's output. */
function snippet(text: string, start: number, length: number): string {
  const lines = text.split(/\r?\n/);
  const firstLine = text.slice(0, start).split('\n').length - 1;
  const lastLine = firstLine + text.slice(start, start + length).split('\n').length - 1;
  const from = Math.max(0, firstLine - SNIPPET_CONTEXT);
  const to = Math.min(lines.length, lastLine + SNIPPET_CONTEXT + 1, from + SNIPPET_MAX_LINES);
  const out: string[] = [];
  for (let i = from; i < to; i++) out.push(`${String(i + 1).padStart(6)}\t${lines[i]}`);
  return out.join('\n');
}
