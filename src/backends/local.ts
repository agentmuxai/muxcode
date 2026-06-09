import path from 'path';
import { existsSync } from 'fs';
import { getServerUrl } from '../llama-server/manager.js';
import { muxHome } from '../llama-server/acquire.js';
import { listInstalled } from '../models/list.js';
import type { IBackend, Message, McpTool, CompletionResponse, ToolCall } from '../types.js';

export class LocalBackend implements IBackend {
  private modelPath: string;
  private onProgress?: (pct: number, label: string) => void;

  constructor(
    modelName: string,
    onProgress?: (pct: number, label: string) => void
  ) {
    this.modelPath = resolveModelPath(modelName);
    this.onProgress = onProgress;
  }

  async complete(messages: Message[], tools: McpTool[]): Promise<CompletionResponse> {
    const start = Date.now();

    // Ensure llama-server is running with this model
    const baseUrl = await getServerUrl(this.modelPath, this.onProgress);

    const body = {
      model: path.basename(this.modelPath, '.gguf'),
      messages: messages.map(toOpenAiMessage),
      tools: tools.length ? tools.map(toOpenAiTool) : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      stream: false,
      temperature: 0.1,
    };

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`llama-server error ${res.status}: ${text}`);
    }

    const data = await res.json() as OpenAiChatResponse;
    if (!data.choices.length) {
      throw new Error('llama-server returned empty choices array');
    }
    const choice = data.choices[0];
    const msg = choice.message;

    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map(tc => {
      let parsedInput: Record<string, unknown>;
      try {
        parsedInput = JSON.parse(tc.function.arguments);
      } catch {
        parsedInput = { _raw: tc.function.arguments };
      }
      return {
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      };
    });

    return {
      text: msg.content ?? '',
      toolCalls,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - start,
      stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use'
               : choice.finish_reason === 'length'    ? 'max_tokens'
               : 'end_turn',
    };
  }
}

function resolveModelPath(nameOrPath: string): string {
  // Absolute path — use directly
  if (path.isAbsolute(nameOrPath)) return nameOrPath;

  // Short name — look in installed models
  const installed = listInstalled();
  const match = installed.find(m => m.name === nameOrPath);
  if (match) return match.path;

  // Try treating as filename in models dir
  const modelsDir = path.join(muxHome(), 'models');
  const guessed = path.join(modelsDir, nameOrPath.replace(':', '-') + '.gguf');
  if (existsSync(guessed)) return guessed;

  throw new Error(
    `Model "${nameOrPath}" not found. Run: mux-code model list\n` +
    `To download: mux-code model pull ${nameOrPath}`
  );
}

function toOpenAiMessage(m: Message): object {
  const content = typeof m.content === 'string' ? m.content : null;
  if (m.role === 'tool') {
    return { role: 'tool', content: content ?? '', tool_call_id: m.tool_call_id ?? '' };
  }
  if (m.role === 'assistant' && m.tool_calls?.length) {
    return {
      role: 'assistant',
      content,
      tool_calls: m.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      })),
    };
  }
  return { role: m.role, content: content ?? '' };
}

function toOpenAiTool(tool: McpTool): object {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

// OpenAI API response types (minimal)
interface OpenAiChatResponse {
  choices: [{
    message: {
      content: string | null;
      tool_calls?: [{
        id: string;
        function: { name: string; arguments: string };
      }];
    };
    finish_reason: string;
  }];
  usage?: { prompt_tokens: number; completion_tokens: number };
}
