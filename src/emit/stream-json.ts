import { randomBytes } from 'crypto';
import type { ToolCall } from '../types.js';
import type { OutputFormat } from '../run-options.js';

export class StreamJsonEmitter {
  readonly sessionId: string;
  private startMs: number;
  private format: OutputFormat;

  constructor(sessionId?: string, format: OutputFormat = 'stream-json') {
    this.sessionId = sessionId ?? `mux-${randomBytes(8).toString('hex')}`;
    this.startMs = Date.now();
    this.format = format;
  }

  init(model: string, mcpServers: string[], tools: string[] = [], permissionMode?: string) {
    this.emit({
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      cwd: process.cwd(),
      tools,
      mcp_servers: mcpServers,
      model,
      ...(permissionMode ? { permissionMode } : {}),
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

  /**
   * `stream-json` writes every event. `json` writes only the final result
   * object; `text` writes only the final result text (errors go to stderr).
   */
  private emit(obj: { type: string; [key: string]: unknown }) {
    // AgentMux reads the session id from any line (host_spawn.rs), so every
    // frame carries it.
    obj.session_id ??= this.sessionId;
    if (this.format === 'stream-json') {
      process.stdout.write(JSON.stringify(obj) + '\n');
      return;
    }
    if (obj.type !== 'result') return;
    if (this.format === 'json') {
      process.stdout.write(JSON.stringify(obj) + '\n');
    } else if (typeof obj.result === 'string') {
      process.stdout.write(obj.result + '\n');
    } else {
      process.stderr.write(`Error: ${String(obj.error ?? 'unknown error')}\n`);
    }
  }
}
