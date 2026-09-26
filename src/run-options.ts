// Options for `muxcode run`, shaped to match what AgentMux (and Claude Code's
// headless mode) pass. AgentMux runs `muxcode run -p --dangerously-skip-permissions
// [--resume <sid>]` and writes the prompt to stdin, so `-p` is a boolean flag
// ("print mode"), not the prompt itself.

export const PERMISSION_MODES = [
  'default',
  'manual',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const OUTPUT_FORMATS = ['stream-json', 'json', 'text'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_MAX_TURNS = 40;

export interface RunOptions {
  prompt?: string;
  backend?: string;
  model?: string;
  baseUrl?: string;
  mcpConfig?: string;
  system?: string;
  appendSystemPrompt?: string;
  resume?: string;
  continueLatest: boolean;
  permissionMode: PermissionMode;
  outputFormat: OutputFormat;
  effort?: EffortLevel;
  maxTurns: number;
}

/** Raw commander options for `run`, before validation. */
export interface RawRunOptions {
  prompt?: string;
  print?: boolean;
  backend?: string;
  model?: string;
  baseUrl?: string;
  mcpConfig?: string;
  system?: string;
  appendSystemPrompt?: string;
  resume?: string;
  continue?: boolean;
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string;
  outputFormat?: string;
  effort?: string;
  maxTurns?: string;
  verbose?: boolean;
  includePartialMessages?: boolean;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid ${name} "${value}". Valid: ${allowed.join(', ')}`);
}

/**
 * Validate raw options and fold in the prompt. The prompt comes from `--prompt`,
 * then the positional words, then `stdinText`. Unknown flags that reached the
 * positional words (commander passes them through) are dropped with a warning
 * rather than becoming part of the prompt.
 */
export function resolveRunOptions(
  raw: RawRunOptions,
  words: string[],
  warn: (msg: string) => void,
): RunOptions & { promptWords: string } {
  const kept: string[] = [];
  for (const w of words) {
    // Only flag-shaped words (`--name`, `-x`) are options; `-1`, `-` and
    // `-.5` are prompt text.
    if (/^--?[A-Za-z]/.test(w)) {
      warn(`ignoring unknown option ${w}`);
    } else {
      kept.push(w);
    }
  }

  let permissionMode: PermissionMode = 'default';
  if (raw.permissionMode) permissionMode = oneOf('--permission-mode', raw.permissionMode, PERMISSION_MODES);
  if (raw.dangerouslySkipPermissions) permissionMode = 'bypassPermissions';
  if (permissionMode === 'manual') permissionMode = 'default';

  let maxTurns = DEFAULT_MAX_TURNS;
  if (raw.maxTurns !== undefined) {
    maxTurns = Number(raw.maxTurns);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error(`Invalid --max-turns "${raw.maxTurns}". Use a positive whole number.`);
    }
  }

  return {
    prompt: raw.prompt,
    promptWords: kept.join(' '),
    backend: raw.backend,
    model: raw.model,
    baseUrl: raw.baseUrl,
    mcpConfig: raw.mcpConfig,
    system: raw.system,
    appendSystemPrompt: raw.appendSystemPrompt,
    resume: raw.resume,
    continueLatest: raw.continue === true,
    permissionMode,
    outputFormat: raw.outputFormat ? oneOf('--output-format', raw.outputFormat, OUTPUT_FORMATS) : 'stream-json',
    effort: raw.effort ? oneOf('--effort', raw.effort, EFFORT_LEVELS) : undefined,
    maxTurns,
  };
}
