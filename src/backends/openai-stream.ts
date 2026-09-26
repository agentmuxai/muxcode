// Turns an OpenAI-style chat-completions chunk stream (the OpenAI SDK's, or
// llama-server's SSE) into StreamSink events and a final CompletionResponse.
import { randomBytes } from 'crypto';
import type { CompletionResponse, ContentPart, StopReason, StreamSink, ToolCall, Usage } from '../types.js';

/** The fields of a chat.completion.chunk this reads. */
export interface OpenAiChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** llama-server (`--reasoning-format deepseek`) and other compatible servers. */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
}

interface Block {
  part: ContentPart;
  /** tool_use blocks: the raw argument JSON as it streams. */
  args?: string;
}

export async function consumeOpenAiStream(
  chunks: AsyncIterable<OpenAiChunk>,
  sink: StreamSink,
  fallbackModel: string,
  startMs: number,
): Promise<CompletionResponse> {
  const blocks: Block[] = [];
  const toolBlockByIndex = new Map<number, number>();
  let open = -1;
  let started = false;
  let id = `msg-${randomBytes(8).toString('hex')}`;
  let model = fallbackModel;
  let finish: string | null = null;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

  const start = (chunk: OpenAiChunk) => {
    if (started) return;
    started = true;
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    sink.messageStart(id, model, { ...usage });
  };
  const close = () => {
    if (open >= 0) sink.blockStop(open);
    open = -1;
  };
  const openBlock = (part: ContentPart, extra: Partial<Block> = {}) => {
    close();
    blocks.push({ part, ...extra });
    open = blocks.length - 1;
    if (part.type === 'tool_use') {
      sink.blockStart(open, { type: 'tool_use', id: part.id!, name: part.name! });
    } else {
      sink.blockStart(open, { type: part.type as 'text' | 'thinking' });
    }
    return open;
  };

  for await (const chunk of chunks) {
    start(chunk);
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      usage.inputTokens = (chunk.usage.prompt_tokens ?? 0) - cached;
      usage.cacheReadInputTokens = cached;
      usage.outputTokens = chunk.usage.completion_tokens ?? 0;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (delta.reasoning_content) {
      if (open < 0 || blocks[open].part.type !== 'thinking') openBlock({ type: 'thinking', thinking: '' });
      blocks[open].part.thinking += delta.reasoning_content;
      sink.thinkingDelta(open, delta.reasoning_content);
    }
    if (delta.content) {
      if (open < 0 || blocks[open].part.type !== 'text') openBlock({ type: 'text', text: '' });
      blocks[open].part.text += delta.content;
      sink.textDelta(open, delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const key = tc.index ?? 0;
      let at = toolBlockByIndex.get(key);
      if (at === undefined) {
        at = openBlock(
          { type: 'tool_use', id: tc.id || `call_${randomBytes(6).toString('hex')}`, name: tc.function?.name ?? '', input: {} },
          { args: '' },
        );
        toolBlockByIndex.set(key, at);
      }
      const argsDelta = tc.function?.arguments;
      if (argsDelta) {
        blocks[at].args += argsDelta;
        // Claude's stream has one open block at a time; a delta for an earlier
        // tool call (rare) is kept, and arrives complete in the final frame.
        if (at === open) sink.inputJsonDelta(at, argsDelta);
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (!started) start({});
  close();

  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) {
    if (b.part.type === 'tool_use') {
      const input = parseArgs(b.args ?? '');
      const call = { id: b.part.id!, name: b.part.name!, input };
      toolCalls.push(call);
      content.push({ type: 'tool_use', ...call });
    } else {
      content.push(b.part);
    }
  }
  const stopReason: StopReason =
    toolCalls.length > 0 ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
  sink.messageDelta(stopReason, { ...usage });

  return {
    id,
    model,
    content,
    text: content.filter(p => p.type === 'text').map(p => p.text ?? '').join(''),
    toolCalls,
    usage,
    durationMs: Date.now() - startMs,
    stopReason,
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

/** Parse a `text/event-stream` body of `data: {json}` lines, ending at `data: [DONE]`. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<OpenAiChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield JSON.parse(data) as OpenAiChunk;
    }
  }
}
