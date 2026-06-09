import Anthropic from '@anthropic-ai/sdk';
import type { IBackend, Message, McpTool, CompletionResponse, ToolCall } from '../types.js';

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
    const userMessages = messages.filter(m => m.role !== 'system');

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemMsg ? String(systemMsg.content) : undefined,
      messages: userMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : (m.content as any),
      })),
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
      stopReason: response.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
    };
  }
}
