import { readFile, stat } from 'fs/promises';
import type { BuiltinTool } from './types.js';
import { optNumber, reqString, resolvePath, ToolError } from './util.js';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
/** Larger files are refused rather than loaded whole; Grep or Bash can slice them. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const readTool: BuiltinTool = {
  spec: {
    name: 'Read',
    description:
      'Reads a file from the local filesystem. file_path may be absolute or relative to the working directory. ' +
      `By default reads up to ${DEFAULT_LIMIT} lines from the start; use offset (1-based line number) and limit to ` +
      'read a specific part of a long file. Output is in cat -n format: line number, a tab, then the line. ' +
      `Lines longer than ${MAX_LINE_CHARS} characters are truncated. Text files only; directories are an error ` +
      '(use Bash ls or Glob to list them).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The path to the file to read (absolute, or relative to the working directory)' },
        offset: { type: 'number', description: 'The line number to start reading from (1-based). Only provide if the file is too large to read at once' },
        limit: { type: 'number', description: 'The number of lines to read. Only provide if the file is too large to read at once' },
      },
      required: ['file_path'],
    },
    _serverId: '',
    readOnly: true,
    builtin: true,
  },

  async run(input, ctx) {
    const filePath = resolvePath(ctx.cwd, reqString(input, 'file_path', { allowEmpty: false }));
    const offset = Math.max(1, Math.floor(optNumber(input, 'offset') ?? 1));
    const limit = Math.floor(optNumber(input, 'limit') ?? DEFAULT_LIMIT);
    if (limit < 1) throw new ToolError('"limit" must be at least 1');

    let info;
    try {
      info = await stat(filePath);
    } catch {
      throw new ToolError(`File does not exist: ${filePath}`);
    }
    if (info.isDirectory()) throw new ToolError(`${filePath} is a directory, not a file. Use Bash (ls) or Glob to list it.`);
    if (info.size > MAX_FILE_BYTES) {
      throw new ToolError(`${filePath} is too large to read (${info.size} bytes). Use Grep to search it, or Bash (e.g. head, sed -n) to read part of it.`);
    }

    const buf = await readFile(filePath);
    // A NUL byte near the start is the usual sign of a binary file.
    if (buf.subarray(0, 8192).includes(0)) {
      throw new ToolError(`${filePath} looks like a binary file (${buf.length} bytes). Read supports text files only.`);
    }

    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text === '') return `(${filePath} exists but is empty.)`;

    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (offset > lines.length) {
      return `(${filePath} has ${lines.length} line${lines.length === 1 ? '' : 's'}; offset ${offset} is past the end.)`;
    }

    const end = Math.min(lines.length, offset - 1 + limit);
    const out: string[] = [];
    for (let i = offset - 1; i < end; i++) {
      let line = lines[i];
      if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS) + '... [line truncated]';
      out.push(`${String(i + 1).padStart(6)}\t${line}`);
    }
    let result = out.join('\n');
    if (offset > 1 || end < lines.length) {
      result += `\n\n(Showing lines ${offset}-${end} of ${lines.length}. Use offset and limit to read other parts.)`;
    }
    return result;
  },
};
