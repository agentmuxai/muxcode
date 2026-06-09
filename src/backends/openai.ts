import OpenAI from 'openai';
import type { IBackend, Message, McpTool, CompletionResponse, ToolCall } from '../types.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';

export class OpenAiBackend implements IBackend {
  private client: OpenAI;
  private model: string;

  constructor(model = 'gpt-4o', baseUrl?: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    // Only throw if no baseUrl (i.e., it's a real OpenAI call, not compat)
    if (!apiKey && !baseUrl && !process.env.OPENAI_BASE_URL) {
      throw new Error('OPENAI_API_KEY not set');
    }
    this.client = new OpenAI({
      apiKey: apiKey ?? 'sk-no-key',
      baseURL: baseUrl ?? process.env.OPENAI_BASE_URL,
    });
    this.model = model;
  }

  async complete(messages: Message[], tools: McpTool[]): Promise<CompletionResponse> {
    const start = Date.now();

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAiMessage),
      tools: tools.length ? tools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      })) : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      temperature: 0.1,
    });

    if (!response.choices.length) {
      throw new Error('OpenAI returned empty choices array');
    }
    const choice = response.choices[0];
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
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - start,
      stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use'
               : choice.finish_reason === 'length'    ? 'max_tokens'
               : 'end_turn',
    };
  }
}

function toOpenAiMessage(m: Message): ChatCompletionMessageParam {
  const content = typeof m.content === 'string' ? m.content : null;
  switch (m.role) {
    case 'system':
      return { role: 'system', content: content ?? '' };
    case 'user':
      return { role: 'user', content: content ?? '' };
    case 'assistant': {
      const msg: ChatCompletionMessageParam = { role: 'assistant', content };
      if (m.tool_calls?.length) {
        (msg as { role: 'assistant'; content: string | null; tool_calls?: unknown[] }).tool_calls =
          m.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }));
      }
      return msg;
    }
    case 'tool':
      return {
        role: 'tool',
        content: content ?? '',
        tool_call_id: m.tool_call_id ?? '',
      };
  }
}
