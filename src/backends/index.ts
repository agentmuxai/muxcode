import type { IBackend } from '../types.js';
import { LocalBackend } from './local.js';
import { AnthropicBackend } from './anthropic.js';
import { OpenAiBackend } from './openai.js';

export interface BackendOptions {
  backend?: string;
  model?: string;
  baseUrl?: string;
  onProgress?: (pct: number, label: string) => void;
}

export function createBackend(opts: BackendOptions): IBackend {
  const backend = opts.backend ?? autoDetectBackend();

  switch (backend) {
    case 'local':
      return new LocalBackend(opts.model ?? defaultLocalModel(), opts.onProgress);

    case 'anthropic':
      return new AnthropicBackend(opts.model ?? 'claude-sonnet-4-6');

    case 'openai':
      return new OpenAiBackend(opts.model ?? 'gpt-4o');

    case 'openai-compat':
      if (!opts.baseUrl && !process.env.OPENAI_BASE_URL) {
        throw new Error('--base-url required for openai-compat backend');
      }
      return new OpenAiBackend(opts.model ?? 'local', opts.baseUrl);

    default:
      throw new Error(
        `Unknown backend "${backend}". Valid: local, anthropic, openai, openai-compat`
      );
  }
}

function autoDetectBackend(): string {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.OPENAI_BASE_URL) return 'openai-compat';
  return 'local';
}

function defaultLocalModel(): string {
  return process.env.MUX_MODEL ?? 'qwen2.5-coder:7b';
}
