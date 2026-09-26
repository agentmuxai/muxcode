import path from 'path';
import { existsSync } from 'fs';
import { getServerUrl } from '../llama-server/manager.js';
import { muxHome } from '../llama-server/acquire.js';
import { listInstalled } from '../models/list.js';
import type { CompleteOptions, CompletionResponse, IBackend, McpTool, Message, StreamSink } from '../types.js';
import { consumeOpenAiStream, parseSse } from './openai-stream.js';
import { toOpenAiMessage, toOpenAiTool } from './openai.js';

export class LocalBackend implements IBackend {
  private modelPath: string;
  private onProgress?: (pct: number, label: string) => void;
  readonly model: string;

  constructor(
    modelName: string,
    onProgress?: (pct: number, label: string) => void
  ) {
    this.modelPath = resolveModelPath(modelName);
    this.model = path.basename(this.modelPath, '.gguf');
    this.onProgress = onProgress;
  }

  async complete(messages: Message[], tools: McpTool[], sink: StreamSink, opts: CompleteOptions = {}): Promise<CompletionResponse> {
    const start = Date.now();

    // Ensure llama-server is running with this model
    const baseUrl = await getServerUrl(this.modelPath, this.onProgress);

    const body = {
      model: this.model,
      messages: messages.map(toOpenAiMessage),
      tools: tools.length ? tools.map(toOpenAiTool) : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.1,
      // Passed to the model's chat template (e.g. gpt-oss reads reasoning_effort).
      ...(opts.effort ? { chat_template_kwargs: { reasoning_effort: opts.effort === 'max' ? 'high' : opts.effort } } : {}),
    };

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new Error(`llama-server error ${res.status}: ${text}`);
    }

    return consumeOpenAiStream(parseSse(res.body), sink, this.model, start);
  }
}

function resolveModelPath(nameOrPath: string): string {
  // Absolute path — use directly
  if (path.isAbsolute(nameOrPath)) return nameOrPath;

  // Short name — look in installed models
  const installed = listInstalled();
  const match = installed.find(m => m.name === nameOrPath);
  if (match) return match.path;

  // Try treating as filename in models dir
  const modelsDir = path.join(muxHome(), 'models');
  const guessed = path.join(modelsDir, nameOrPath.replace(':', '-') + '.gguf');
  if (existsSync(guessed)) return guessed;

  throw new Error(
    `Model "${nameOrPath}" not found. Run: muxcode model list\n` +
    `To download: muxcode model pull ${nameOrPath}`
  );
}
