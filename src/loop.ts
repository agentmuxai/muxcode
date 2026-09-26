import type { CompleteOptions, IBackend, McpTool, Message, ToolCall } from './types.js';
import { executeTool } from './mcp/client.js';
import type { ResultSubtype, RunTotals, StreamJsonEmitter } from './emit/stream-json.js';
import { costUsd } from './pricing.js';
import type { SessionWriter } from './session.js';

const SYSTEM_PROMPT = `You are Mux Code, an agentic coding assistant. You have access to tools that let you read and modify files, run commands, and interact with external services. Be concise and complete tasks efficiently. When you are done with a task, summarize what you did.`;

export interface LoopSettings {
  /** Replaces the built-in system prompt. */
  systemPrompt?: string;
  /** Appended to the system prompt (built-in or replaced). */
  appendSystemPrompt?: string;
  maxTurns: number;
  effort?: CompleteOptions['effort'];
  /** Earlier messages of a resumed session (no system prompt). */
  history?: Message[];
  /** Where each new message is recorded as it happens. */
  session?: SessionWriter;
  /** Aborts the run (Ctrl+C / SIGTERM from AgentMux's interrupt). */
  signal?: AbortSignal;
}

/** Thrown when a run fails; the error result frame has already been written. */
export class LoopError extends Error {}

/** How a run ended; the result frame has already been written. */
export interface LoopOutcome {
  text: string;
  subtype: ResultSubtype;
  interrupted?: boolean;
}

export async function runLoop(
  prompt: string,
  backend: IBackend,
  tools: McpTool[],
  emitter: StreamJsonEmitter,
  settings: LoopSettings,
): Promise<LoopOutcome> {
  let system = settings.systemPrompt ?? SYSTEM_PROMPT;
  if (settings.appendSystemPrompt) system += `\n\n${settings.appendSystemPrompt}`;
  const messages: Message[] = [{ role: 'system', content: system }, ...(settings.history ?? [])];
  const push = (m: Message) => {
    messages.push(m);
    settings.session?.append(m);
  };
  push({ role: 'user', content: prompt });

  let finalText = '';
  const totals: RunTotals = {
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: 0,
    numTurns: 0,
    durationApiMs: 0,
  };

  try {
    for (let turn = 0; turn < settings.maxTurns; turn++) {
      settings.signal?.throwIfAborted();
      const response = await backend.complete(messages, tools, emitter, {
        effort: settings.effort,
        signal: settings.signal,
      });

      totals.numTurns++;
      totals.durationApiMs += response.durationMs;
      totals.usage.inputTokens += response.usage.inputTokens;
      totals.usage.outputTokens += response.usage.outputTokens;
      totals.usage.cacheCreationInputTokens += response.usage.cacheCreationInputTokens;
      totals.usage.cacheReadInputTokens += response.usage.cacheReadInputTokens;
      totals.costUsd += costUsd(response.model, response.usage);

      emitter.assistantMessage(response);
      // Use || not ?? — backends return '' (not null) on tool-only turns, and
      // '' ?? x gives '' (coalescing only skips null/undefined), which would
      // overwrite finalText with empty string each tool-only turn.
      finalText = response.text || finalText;

      // The assistant message as the model sent it (text, thinking, tool_use),
      // plus tool_calls for OpenAI-style backends.
      push({
        role: 'assistant',
        content: response.content,
        ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}),
      });

      if (response.toolCalls.length === 0) {
        emitter.done(finalText, totals, 'success', response.stopReason);
        return { text: finalText, subtype: 'success' };
      }

      // Execute tool calls sequentially — MCP Client is not concurrency-safe
      for (const call of response.toolCalls) {
        settings.signal?.throwIfAborted();
        const output = await executeTool(call, tools);
        const isError = isErrorOutput(output);
        emitter.toolResult(call.id, output, isError);
        push(toolMessage(call, output, isError));
      }
    }

    const maxTurnsNote = `[Stopped after ${settings.maxTurns} turns without completing the task]`;
    const resultText = finalText ? `${finalText}\n\n${maxTurnsNote}` : maxTurnsNote;
    emitter.done(resultText, totals, 'error_max_turns', null);
    return { text: resultText, subtype: 'error_max_turns' };
  } catch (err) {
    if (settings.signal?.aborted) {
      emitter.error('Interrupted', totals);
      return { text: 'Interrupted', subtype: 'error_during_execution', interrupted: true };
    }
    const status = (err as { status?: unknown }).status;
    emitter.error((err as Error).message, totals, typeof status === 'number' ? status : undefined);
    throw new LoopError((err as Error).message);
  }
}

function toolMessage(call: ToolCall, output: string, isError: boolean): Message {
  return { role: 'tool', content: output, tool_call_id: call.id, tool_use_id: call.id, is_error: isError };
}

function isErrorOutput(output: string): boolean {
  try {
    const parsed = JSON.parse(output);
    return typeof parsed === 'object' && parsed !== null && 'error' in parsed;
  } catch {
    return false;
  }
}
