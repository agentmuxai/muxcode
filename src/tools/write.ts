import { mkdir, stat, writeFile } from 'fs/promises';
import path from 'path';
import type { BuiltinTool } from './types.js';
import { reqString, resolvePath, ToolError } from './util.js';

export const writeTool: BuiltinTool = {
  spec: {
    name: 'Write',
    description:
      'Writes a file to the local filesystem, overwriting it if it exists and creating missing parent directories. ' +
      'file_path may be absolute or relative to the working directory. Prefer Edit for changing part of an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The path to the file to write (absolute, or relative to the working directory)' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
    _serverId: '',
    builtin: true,
  },

  async run(input, ctx) {
    const filePath = resolvePath(ctx.cwd, reqString(input, 'file_path', { allowEmpty: false }));
    const content = reqString(input, 'content');

    let existed = false;
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) throw new ToolError(`${filePath} is a directory`);
      existed = true;
    } catch (err) {
      if (err instanceof ToolError) throw err;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return existed ? `The file ${filePath} has been overwritten.` : `File created successfully at: ${filePath}`;
  },
};
