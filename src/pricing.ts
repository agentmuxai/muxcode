// List prices in USD per million tokens, for the cost AgentMux shows in its
// footer. Unknown models (and local models) cost 0 rather than a guess.
// Anthropic cache writes cost 1.25x input and cache reads 0.1x; OpenAI's
// cached input is billed at its own rate and has no write charge.
import type { Usage } from './types.js';

interface Price {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

/** Longest matching prefix wins, so dated model ids resolve to their family. */
const PRICES: Array<[prefix: string, price: Price]> = [
  ['claude-opus-5-5', { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],
  ['gpt-4o-mini', { input: 0.15, output: 0.6, cacheRead: 0.075 }],
  ['gpt-4o', { input: 2.5, output: 10, cacheRead: 1.25 }],
  ['gpt-4.1-mini', { input: 0.4, output: 1.6, cacheRead: 0.1 }],
  ['gpt-4.1', { input: 2, output: 8, cacheRead: 0.5 }],
];

export function priceFor(model: string): Price | undefined {
  let best: [string, Price] | undefined;
  for (const entry of PRICES) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1];
}

export function costUsd(model: string, u: Usage): number {
  const p = priceFor(model);
  if (!p) return 0;
  const cost =
    u.inputTokens * p.input +
    u.outputTokens * p.output +
    u.cacheCreationInputTokens * (p.cacheWrite ?? p.input) +
    u.cacheReadInputTokens * (p.cacheRead ?? p.input);
  return cost / 1_000_000;
}
