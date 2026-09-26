// Mux Code's built-in tools. They carry Claude Code's exact names and
// parameter names because AgentMux keys on them: its stream parser renders
// Read/Edit/Write/Bash/Grep/Glob calls richly, draws the progress checklist
// from TodoWrite, and streams Bash output live.
import type { McpTool, ToolCall } from '../types.js';
import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readTool } from './read.js';
import type { BuiltinTool, ToolContext, ToolOutput } from './types.js';
import { todoWriteTool } from './todo.js';
import { writeTool } from './write.js';

export type { ToolContext, ToolOutput } from './types.js';

const BUILTINS: BuiltinTool[] = [readTool, writeTool, editTool, bashTool, grepTool, globTool, todoWriteTool];
const BY_NAME = new Map(BUILTINS.map(t => [t.spec.name, t]));

export const BUILTIN_TOOLS: McpTool[] = BUILTINS.map(t => t.spec);

export function newToolContext(cwd = process.cwd()): ToolContext {
  return { cwd, todos: [] };
}

/**
 * The built-ins first, then the MCP tools. An MCP tool named like a built-in
 * is dropped rather than allowed to shadow it (namespacing MCP tools as
 * `mcp__<server>__<tool>` is issue #15).
 */
export function withBuiltinTools(mcpTools: McpTool[]): McpTool[] {
  const kept = mcpTools.filter(t => {
    if (!BY_NAME.has(t.name)) return true;
    process.stderr.write(`[tools] Ignoring MCP tool "${t.name}" from ${t._serverId}: it has the same name as a built-in tool\n`);
    return false;
  });
  return [...BUILTIN_TOOLS, ...kept];
}

/** Run a built-in tool. Failures come back as `isError` results, never as throws. */
export async function executeBuiltinTool(call: ToolCall, ctx: ToolContext): Promise<ToolOutput> {
  const tool = BY_NAME.get(call.name);
  if (!tool) return { content: `Tool "${call.name}" not found`, isError: true };
  const input = call.input && typeof call.input === 'object' ? call.input : {};
  try {
    const out = await tool.run(input, ctx);
    return typeof out === 'string' ? { content: out, isError: false } : out;
  } catch (err) {
    return { content: `Error: ${(err as Error).message}`, isError: true };
  }
}
