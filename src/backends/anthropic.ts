import Anthropic from '@anthropic-ai/sdk';
import type {
  CompleteOptions,
  CompletionResponse,
  ContentPart,
  IBackend,
  McpTool,
  Message,
  StopReason,
  StreamSink,
  ToolCall,
  Usage,
} from '../types.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

/** Thinking budget per effort level; the answer gets DEFAULT_MAX_TOKENS on top. */
const THINKING_BUDGET = { low: 2048, medium: 8192, high: 16384, max: 32000 } as const;
const DEFAULT_MAX_TOKENS = 8192;

export class AnthropicBackend implements IBackend {
  private client: Anthropic;
  readonly model: string;

  constructor(model = 'claude-sonnet-4-6') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(messages: Message[], tools: McpTool[], sink: StreamSink, opts: CompleteOptions = {}): Promise<CompletionResponse> {
    const start = Date.now();

    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const budget = opts.effort ? THINKING_BUDGET[opts.effort] : 0;

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: DEFAULT_MAX_TOKENS + budget,
      system: systemMsg ? String(systemMsg.content) : undefined,
      messages: toAnthropicMessages(nonSystem),
      ...(budget ? { thinking: { type: 'enabled' as const, budget_tokens: budget } } : {}),
      ...(tools.length ? {
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      } : {}),
    }, { signal: opts.signal });

    // Anthropic's stream events are already the shape AgentMux renders.
    for await (const ev of stream) {
      switch (ev.type) {
        case 'message_start':
          sink.messageStart(ev.message.id, ev.message.model, toUsage(ev.message.usage));
          break;
        case 'content_block_start': {
          const b = ev.content_block;
          if (b.type === 'tool_use') sink.blockStart(ev.index, { type: 'tool_use', id: b.id, name: b.name });
          else if (b.type === 'text') sink.blockStart(ev.index, { type: 'text' });
          else sink.blockStart(ev.index, { type: 'thinking' });
          break;
        }
        case 'content_block_delta':
          if (ev.delta.type === 'text_delta') sink.textDelta(ev.index, ev.delta.text);
          else if (ev.delta.type === 'thinking_delta') sink.thinkingDelta(ev.index, ev.delta.thinking);
          else if (ev.delta.type === 'input_json_delta') sink.inputJsonDelta(ev.index, ev.delta.partial_json);
          break;
        case 'content_block_stop':
          sink.blockStop(ev.index);
          break;
      }
    }

    const final = await stream.finalMessage();
    const usage = toUsage(final.usage);
    const stopReason: StopReason =
      final.stop_reason === 'tool_use' || final.stop_reason === 'max_tokens' || final.stop_reason === 'stop_sequence'
        ? final.stop_reason
        : 'end_turn';
    sink.messageDelta(stopReason, usage);

    const content = final.content as unknown as ContentPart[];
    const toolCalls: ToolCall[] = final.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));

    return {
      id: final.id,
      model: final.model,
      content,
      text: final.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join(''),
      toolCalls,
      usage,
      durationMs: Date.now() - start,
      stopReason,
    };
  }
}

function toUsage(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
  };
}

function toAnthropicMessages(messages: Message[]): MessageParam[] {
  const result: MessageParam[] = [];

  // The API rejects two turns in a row from the same role. Tool results
  // followed by a new prompt, or a prompt whose run was interrupted before the
  // model answered (then resumed), are both consecutive user turns: merge them
  // into one user message.
  const pushUser = (blocks: Anthropic.ContentBlockParam[]) => {
    const last = result[result.length - 1];
    if (last?.role === 'user') {
      const prev: Anthropic.ContentBlockParam[] = typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }]
        : (last.content as Anthropic.ContentBlockParam[]);
      last.content = [...prev, ...blocks];
    } else {
      result.push({ role: 'user', content: blocks });
    }
  };

  for (const m of messages) {
    if (m.role === 'assistant') {
      // The response's own blocks (text, thinking with its signature, tool_use),
      // as the API requires them back when thinking is on.
      result.push({
        role: 'assistant',
        content: typeof m.content === 'string'
          ? m.content
          : (m.content as unknown as Anthropic.ContentBlockParam[]),
      });
    } else if (m.role === 'tool') {
      // Anthropic expects tool results as tool_result blocks in a user message.
      pushUser([{
        type: 'tool_result',
        tool_use_id: m.tool_use_id ?? m.tool_call_id ?? '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ...(m.is_error ? { is_error: true } : {}),
      }]);
    } else {
      pushUser([{ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]);
    }
  }

  return result;
}
