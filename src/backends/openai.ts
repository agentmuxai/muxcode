import OpenAI from 'openai';
import type { CompleteOptions, CompletionResponse, IBackend, McpTool, Message, StreamSink } from '../types.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { consumeOpenAiStream, type OpenAiChunk } from './openai-stream.js';

export class OpenAiBackend implements IBackend {
  private client: OpenAI;
  readonly model: string;

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

  async complete(messages: Message[], tools: McpTool[], sink: StreamSink, opts: CompleteOptions = {}): Promise<CompletionResponse> {
    const start = Date.now();
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAiMessage),
      tools: tools.length ? tools.map(toOpenAiTool) : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      stream: true,
      stream_options: { include_usage: true },
      // Reasoning models reject a temperature; set effort instead.
      ...(opts.effort
        ? { reasoning_effort: (opts.effort === 'max' ? 'high' : opts.effort) as 'low' | 'medium' | 'high' }
        : { temperature: 0.1 }),
    }, { signal: opts.signal });
    return consumeOpenAiStream(stream as AsyncIterable<OpenAiChunk>, sink, this.model, start);
  }
}

export function toOpenAiTool(t: McpTool) {
  return {
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  };
}

export function toOpenAiMessage(m: Message): ChatCompletionMessageParam {
  // For ContentPart[] (tool-use turns), keep the text blocks; '' → null so that
  // tool-only assistant turns don't send empty-string content alongside tool_calls
  // (some compat endpoints reject that combination).
  const content = typeof m.content === 'string'
    ? m.content
    : Array.isArray(m.content)
      ? (m.content as Array<{ type: string; text?: string }>)
          .filter(p => p.type === 'text').map(p => p.text ?? '').join('') || null
      : null;
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
