import { glob, stat } from 'fs/promises';
import path from 'path';
import type { BuiltinTool } from './types.js';
import { optString, reqString, resolvePath, ToolError } from './util.js';

const MAX_RESULTS = 100;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export const globTool: BuiltinTool = {
  spec: {
    name: 'Glob',
    description:
      'Finds files by name with a glob pattern (e.g. "**/*.js", "src/**/*.ts"). Returns matching file paths, ' +
      `most recently modified first (at most ${MAX_RESULTS}). Skips .git and node_modules.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against' },
        path: { type: 'string', description: 'The directory to search in (default: the working directory)' },
      },
      required: ['pattern'],
    },
    _serverId: '',
    readOnly: true,
    builtin: true,
  },

  async run(input, ctx) {
    // Glob syntax uses "/"; on Windows a "\" would be read as an escape.
    let pattern = reqString(input, 'pattern', { allowEmpty: false });
    if (process.platform === 'win32') pattern = pattern.replace(/\\/g, '/');
    const root = resolvePath(ctx.cwd, optString(input, 'path') ?? '.');
    try {
      if (!(await stat(root)).isDirectory()) throw new ToolError(`${root} is not a directory`);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Directory does not exist: ${root}`);
    }

    const found: { file: string; mtime: number }[] = [];
    const matches = glob(pattern, {
      cwd: root,
      withFileTypes: true,
      exclude: d => d.isDirectory() && SKIP_DIRS.has(d.name),
    });
    for await (const d of matches) {
      if (!d.isFile()) continue;
      const file = path.join(d.parentPath, d.name);
      const mtime = await stat(file).then(s => s.mtimeMs, () => 0);
      found.push({ file, mtime });
    }
    if (found.length === 0) return 'No files found';

    found.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
    const shown = found.slice(0, MAX_RESULTS).map(f => f.file);
    if (found.length > MAX_RESULTS) {
      shown.push(`(Results are truncated: showing ${MAX_RESULTS} of ${found.length}. Use a more specific path or pattern.)`);
    }
    return shown.join('\n');
  },
};
