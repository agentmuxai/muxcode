export type Backend = 'local' | 'anthropic' | 'openai' | 'openai-compat';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  tool_call_id?: string;   // OpenAI: links tool result to assistant tool_calls entry
  tool_use_id?: string;    // Anthropic: links tool_result block to tool_use block
  tool_calls?: ToolCall[]; // OpenAI: assistant message carrying pending tool invocations
  is_error?: boolean;      // tool results: the tool failed
}

export interface ContentPart {
  type: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  /** Thinking blocks: the reasoning text, and Anthropic's signature (sent back on the next request). */
  thinking?: string;
  signature?: string;
  /** redacted_thinking blocks. */
  data?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

export interface CompletionResponse {
  /** The model's message id, and the model that answered. */
  id: string;
  model: string;
  /** The assistant message's blocks in order (text, thinking, tool_use), as sent back next turn. */
  content: ContentPart[];
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  durationMs: number;
  stopReason: StopReason;
}

/** One block of a streamed assistant message. */
export type StreamBlock =
  | { type: 'text' }
  | { type: 'thinking' }
  | { type: 'tool_use'; id: string; name: string };

/**
 * Receives a model response as it streams, in the shape of Anthropic's Messages
 * streaming events (which AgentMux renders): a message start, then blocks, each
 * started, filled by deltas and stopped, then the stop reason and usage.
 */
export interface StreamSink {
  messageStart(id: string, model: string, usage: Usage): void;
  blockStart(index: number, block: StreamBlock): void;
  textDelta(index: number, text: string): void;
  thinkingDelta(index: number, thinking: string): void;
  inputJsonDelta(index: number, partialJson: string): void;
  blockStop(index: number): void;
  messageDelta(stopReason: StopReason, usage: Usage): void;
}

export interface CompleteOptions {
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Cancels the request (the run was interrupted). */
  signal?: AbortSignal;
}

export interface IBackend {
  /** The model requested (backends report the model that answered on each response). */
  readonly model: string;
  /**
   * The context window the model runs with, when the backend knows it (a local
   * model: the size llama-server is started with). Reported in the result's
   * `modelUsage`, where AgentMux's context meter reads it. Absent for remote
   * backends, whose window muxcode doesn't know.
   */
  readonly contextWindow?: number;
  complete(messages: Message[], tools: McpTool[], sink: StreamSink, opts?: CompleteOptions): Promise<CompletionResponse>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  _serverId: string;
  /** The server marked the tool read-only (MCP `annotations.readOnlyHint`). */
  readOnly?: boolean;
  /** One of Mux Code's own tools (src/tools), run in-process rather than over MCP. */
  builtin?: boolean;
}

export interface LoopOptions {
  prompt: string;
  backend: IBackend;
  mcpTools: McpTool[];
  executeTool: (call: ToolCall) => Promise<string>;
  maxTurns?: number;
  systemPrompt?: string;
  sessionId?: string;
}

export interface CatalogEntry {
  name: string;
  display_name: string;
  description: string;
  hf_repo: string;
  hf_filename: string;
  hf_branch: string;
  size_gb: number;
  sha256: string;
  context_window: number;
  capabilities: string[];
  tool_call_tier: 1 | 2 | 3;
  min_ram_gb: number;
  quantization: string;
  recommended_for: string[];
  tags: string[];
}

export interface Catalog {
  version: string;
  models: CatalogEntry[];
}

export interface InstalledModel {
  name: string;
  path: string;
  size_gb: number;
  context_window: number;
  tool_call_tier: 1 | 2 | 3;
  downloaded_at: string;
}
