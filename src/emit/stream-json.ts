import { randomBytes } from 'crypto';
import type { ToolCall } from '../types.js';

export class StreamJsonEmitter {
  readonly sessionId: string;
  private startMs: number;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `mux-${randomBytes(8).toString('hex')}`;
    this.startMs = Date.now();
  }

  init(model: string, mcpServers: string[]) {
    this.emit({
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      tools: [],
      mcp_servers: mcpServers,
      model,
    });
  }

  loading(model: string) {
    this.emit({ type: 'system', subtype: 'loading', model, session_id: this.sessionId });
  }

  assistantText(text: string) {
    this.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    });
  }

  toolUse(call: ToolCall) {
    this.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input,
        }],
      },
    });
  }

  toolResult(id: string, output: string, isError = false) {
    this.emit({
      type: 'tool',
      tool_use_id: id,
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        is_error: isError,
        content: [{ type: 'text', text: output }],
      }],
    });
  }

  done(resultText: string, inputTokens = 0, outputTokens = 0) {
    this.emit({
      type: 'result',
      subtype: 'success',
      cost_usd: 0,
      duration_ms: Date.now() - this.startMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      result: resultText,
      session_id: this.sessionId,
    });
  }

  error(message: string, inputTokens = 0, outputTokens = 0) {
    this.emit({
      type: 'result',
      subtype: 'error',
      cost_usd: 0,
      duration_ms: Date.now() - this.startMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      error: message,
      session_id: this.sessionId,
    });
  }

  private emit(obj: object) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
}
