import type { McpTool } from '../types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

/** Per-run state the built-in tools share. */
export interface ToolContext {
  /** Relative paths resolve against this; Bash runs here. */
  cwd: string;
  /** The TodoWrite list, kept in memory for the run. */
  todos: Todo[];
  /** The run's interrupt: long-running tools (Bash) stop when it fires. */
  signal?: AbortSignal;
}

/** A tool's result: what the model sees, whether it failed, and Claude's `tool_use_result`. */
export interface ToolOutput {
  content: string;
  isError: boolean;
  structured?: Record<string, unknown>;
}

export interface BuiltinTool {
  spec: McpTool;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput | string>;
}
