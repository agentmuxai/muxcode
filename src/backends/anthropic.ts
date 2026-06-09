import Anthropic from '@anthropic-ai/sdk';
import type { IBackend, Message, McpTool, CompletionResponse, ToolCall } from '../types.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

export class AnthropicBackend implements IBackend {
  private client: Anthropic;
  private model: string;

  constructor(model = 'claude-sonnet-4-6') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(messages: Message[], tools: McpTool[]): Promise<CompletionResponse> {
    const start = Date.now();

    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemMsg ? String(systemMsg.content) : undefined,
      messages: toAnthropicMessages(nonSystem),
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    });

    const toolCalls: ToolCall[] = response.content
      .filter(b => b.type === 'tool_use')
      .map(b => {
        const tb = b as Anthropic.ToolUseBlock;
        return { id: tb.id, name: tb.name, input: tb.input as Record<string, unknown> };
      });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('');

    return {
      text,
      toolCalls,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      durationMs: Date.now() - start,
      stopReason: response.stop_reason === 'tool_use'   ? 'tool_use'
               : response.stop_reason === 'max_tokens' ? 'max_tokens'
               : 'end_turn',
    };
  }
}

function toAnthropicMessages(messages: Message[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'assistant') {
      // Content already contains Anthropic-format blocks (text + tool_use) from loop.ts
      result.push({
        role: 'assistant',
        content: typeof m.content === 'string'
          ? m.content
          : (m.content as Anthropic.ContentBlock[]),
      });
    } else if (m.role === 'tool') {
      // Anthropic expects tool results as a user message with tool_result content blocks.
      // Merge consecutive tool results into a single user message.
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.tool_use_id ?? m.tool_call_id ?? '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };

      const last = result[result.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) {
        (last.content as Anthropic.ToolResultBlockParam[]).push(block);
      } else {
        result.push({ role: 'user', content: [block] });
      }
    } else {
      // user messages
      result.push({
        role: 'user',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    }
  }

  return result;
}
