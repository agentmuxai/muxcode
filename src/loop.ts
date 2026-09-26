import type { CompleteOptions, IBackend, McpTool, Message, ToolCall } from './types.js';
import { executeTool } from './mcp/client.js';
import type { RunTotals, StreamJsonEmitter } from './emit/stream-json.js';
import { costUsd } from './pricing.js';

const SYSTEM_PROMPT = `You are Mux Code, an agentic coding assistant. You have access to tools that let you read and modify files, run commands, and interact with external services. Be concise and complete tasks efficiently. When you are done with a task, summarize what you did.`;

export interface LoopSettings {
  /** Replaces the built-in system prompt. */
  systemPrompt?: string;
  /** Appended to the system prompt (built-in or replaced). */
  appendSystemPrompt?: string;
  maxTurns: number;
  effort?: CompleteOptions['effort'];
}

/** Thrown when a run fails; the error result frame has already been written. */
export class LoopError extends Error {}

export async function runLoop(
  prompt: string,
  backend: IBackend,
  tools: McpTool[],
  emitter: StreamJsonEmitter,
  settings: LoopSettings,
): Promise<string> {
  let system = settings.systemPrompt ?? SYSTEM_PROMPT;
  if (settings.appendSystemPrompt) system += `\n\n${settings.appendSystemPrompt}`;
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];

  let finalText = '';
  const totals: RunTotals = {
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: 0,
    numTurns: 0,
    durationApiMs: 0,
  };

  try {
    for (let turn = 0; turn < settings.maxTurns; turn++) {
      const response = await backend.complete(messages, tools, emitter, { effort: settings.effort });

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

      if (response.toolCalls.length === 0) {
        emitter.done(finalText, totals, 'success', response.stopReason);
        return finalText;
      }

      // The assistant message as the model sent it (text, thinking, tool_use),
      // plus tool_calls for OpenAI-style backends.
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      });

      // Execute tool calls sequentially — MCP Client is not concurrency-safe
      for (const call of response.toolCalls) {
        const output = await executeTool(call, tools);
        const isError = isErrorOutput(output);
        emitter.toolResult(call.id, output, isError);
        messages.push(toolMessage(call, output, isError));
      }
    }

    const maxTurnsNote = `[Stopped after ${settings.maxTurns} turns without completing the task]`;
    const resultText = finalText ? `${finalText}\n\n${maxTurnsNote}` : maxTurnsNote;
    emitter.done(resultText, totals, 'error_max_turns', null);
    return resultText;
  } catch (err) {
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
