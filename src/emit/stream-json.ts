// Claude Code's stream-json, in the shape AgentMux's translator reads
// (agentmux frontend/app/view/agent/providers/claude-translator.ts):
//   - text and thinking render from `stream_event` deltas only;
//   - tool calls from `content_block_start` + `input_json_delta`, repeated
//     with final params in the `assistant` frames;
//   - one `assistant` frame per content block, each stamped with the
//     message's stop_reason: a text-only frame without stop_reason
//     "tool_use" ends the turn in the UI;
//   - tool results as `user` frames with `tool_result` blocks;
//   - the `result` frame's cost_usd, duration_ms, num_turns and usage fill
//     the footer; is_error + result report a failure.
import { randomBytes } from 'crypto';
import type { CompletionResponse, StopReason, StreamBlock, StreamSink, Usage } from '../types.js';
import type { OutputFormat } from '../run-options.js';

export interface RunTotals {
  usage: Usage;
  costUsd: number;
  numTurns: number;
  durationApiMs: number;
}

export type ResultSubtype = 'success' | 'error_during_execution' | 'error_max_turns';

function wireUsage(u: Usage) {
  return {
    input_tokens: u.inputTokens,
    cache_creation_input_tokens: u.cacheCreationInputTokens,
    cache_read_input_tokens: u.cacheReadInputTokens,
    output_tokens: u.outputTokens,
  };
}

export class StreamJsonEmitter implements StreamSink {
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
      cwd: process.cwd(),
      tools,
      mcp_servers: mcpServers.map(name => ({ name, status: 'connected' })),
      model,
      ...(permissionMode ? { permissionMode } : {}),
    });
  }

  /** Model download / server start progress (not yet rendered by AgentMux). */
  loading(model: string) {
    this.emit({ type: 'system', subtype: 'loading', model });
  }

  /** The model is rate-limited and will be retried after `retryAfterMs`. */
  rateLimited(retryAfterMs: number | null) {
    this.emit({ type: 'rate_limit_event', retry_after_ms: retryAfterMs });
  }

  // ── StreamSink: the model's response as it streams ─────────────────────

  messageStart(id: string, model: string, usage: Usage) {
    this.streamEvent({
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: wireUsage(usage) },
    });
  }

  blockStart(index: number, block: StreamBlock) {
    const content_block =
      block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
      : block.type === 'thinking' ? { type: 'thinking', thinking: '' }
      : { type: 'text', text: '' };
    this.streamEvent({ type: 'content_block_start', index, content_block });
  }

  textDelta(index: number, text: string) {
    this.streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
  }

  thinkingDelta(index: number, thinking: string) {
    this.streamEvent({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
  }

  inputJsonDelta(index: number, partialJson: string) {
    this.streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } });
  }

  blockStop(index: number) {
    this.streamEvent({ type: 'content_block_stop', index });
  }

  messageDelta(stopReason: StopReason, usage: Usage) {
    this.streamEvent({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: wireUsage(usage) });
    this.streamEvent({ type: 'message_stop' });
  }

  // ── Complete messages ───────────────────────────────────────────────────

  /** One `assistant` frame per content block, as Claude Code emits them. */
  assistantMessage(r: CompletionResponse) {
    for (const block of r.content) {
      this.emit({
        type: 'assistant',
        message: {
          id: r.id,
          type: 'message',
          role: 'assistant',
          model: r.model,
          content: [block],
          stop_reason: r.stopReason,
          stop_sequence: null,
          usage: wireUsage(r.usage),
        },
        parent_tool_use_id: null,
      });
    }
  }

  /**
   * A tool's result, as a `user` frame. `structured` is Claude's sibling
   * `tool_use_result` ({stdout, stderr, interrupted}) for shell-like tools.
   */
  toolResult(toolUseId: string, content: string, isError: boolean, structured?: Record<string, unknown>) {
    this.emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
      parent_tool_use_id: null,
      ...(structured ? { tool_use_result: structured } : {}),
    });
  }

  done(resultText: string, totals: RunTotals, subtype: ResultSubtype = 'success', stopReason: StopReason | null = 'end_turn') {
    this.result({
      subtype,
      is_error: subtype !== 'success',
      result: resultText,
      stop_reason: stopReason,
    }, totals);
  }

  error(message: string, totals?: RunTotals, apiErrorStatus?: number) {
    this.result({
      subtype: 'error_during_execution',
      is_error: true,
      result: message,
      ...(apiErrorStatus ? { api_error_status: apiErrorStatus } : {}),
    }, totals);
  }

  private result(fields: Record<string, unknown>, totals?: RunTotals) {
    const t = totals ?? { usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, costUsd: 0, numTurns: 0, durationApiMs: 0 };
    this.emit({
      type: 'result',
      ...fields,
      duration_ms: Date.now() - this.startMs,
      duration_api_ms: t.durationApiMs,
      num_turns: t.numTurns,
      // Claude Code's field, and the one AgentMux's footer reads.
      total_cost_usd: t.costUsd,
      cost_usd: t.costUsd,
      usage: wireUsage(t.usage),
    });
  }

  private streamEvent(event: Record<string, unknown>) {
    this.emit({ type: 'stream_event', event, parent_tool_use_id: null });
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
    } else if (obj.is_error) {
      process.stderr.write(`Error: ${String(obj.result ?? 'unknown error')}\n`);
    } else {
      process.stdout.write(String(obj.result ?? '') + '\n');
    }
  }
}
