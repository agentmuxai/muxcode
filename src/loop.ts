import type { IBackend, Message, McpTool, ToolCall, ContentPart } from './types.js';
import { executeTool } from './mcp/client.js';
import type { StreamJsonEmitter } from './emit/stream-json.js';

const MAX_TURNS = 40;
const SYSTEM_PROMPT = `You are Mux Code, an agentic coding assistant. You have access to tools that let you read and modify files, run commands, and interact with external services. Be concise and complete tasks efficiently. When you are done with a task, summarize what you did.`;

export async function runLoop(
  prompt: string,
  backend: IBackend,
  tools: McpTool[],
  emitter: StreamJsonEmitter,
  systemOverride?: string,
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: systemOverride ?? SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  let finalText = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await backend.complete(messages, tools);

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    if (response.text) {
      emitter.assistantText(response.text);
      finalText = response.text;
    }

    if (response.toolCalls.length === 0) {
      emitter.done(finalText, totalInputTokens, totalOutputTokens);
      return finalText;
    }

    // Add assistant message with tool calls (content for Anthropic, tool_calls for OpenAI)
    messages.push({
      role: 'assistant',
      content: buildAssistantContent(response.text, response.toolCalls),
      tool_calls: response.toolCalls,
    });

    // Execute tool calls sequentially — MCP Client is not concurrency-safe
    const toolResults: { call: ToolCall; output: string; isError: boolean }[] = [];
    for (const call of response.toolCalls) {
      emitter.toolUse(call);
      const output = await executeTool(call, tools);
      const isError = isErrorOutput(output);
      emitter.toolResult(call.id, output, isError);
      toolResults.push({ call, output, isError });
    }

    // Add tool results to message history
    for (const { call, output } of toolResults) {
      messages.push({
        role: 'tool',
        content: output,
        tool_call_id: call.id,
        tool_use_id: call.id,
      });
    }
  }

  emitter.error(`Reached max turns (${MAX_TURNS}) without completing task`);
  return finalText;
}

function buildAssistantContent(text: string, toolCalls: ToolCall[]): ContentPart[] {
  const blocks: ContentPart[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const tc of toolCalls) {
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  return blocks;
}

function isErrorOutput(output: string): boolean {
  try {
    const parsed = JSON.parse(output);
    return typeof parsed === 'object' && parsed !== null && 'error' in parsed;
  } catch {
    return false;
  }
}
