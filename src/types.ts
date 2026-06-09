export type Backend = 'local' | 'anthropic' | 'openai' | 'openai-compat';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  tool_call_id?: string;  // OpenAI format
  tool_use_id?: string;   // Anthropic format
}

export interface ContentPart {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

export interface IBackend {
  complete(messages: Message[], tools: McpTool[]): Promise<CompletionResponse>;
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
