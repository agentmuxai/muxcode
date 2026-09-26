import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import type { BuiltinTool } from './types.js';
import { findOnPath, HeadTail, optNumber, reqString, ToolError } from './util.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Per stream, head+tail. Spilling the full output to a file is issue #11. */
const MAX_OUTPUT_CHARS = 30_000;
/** After the shell exits, how long to wait for its pipes to close (a backgrounded child can hold them open). */
const PIPE_GRACE_MS = 250;

interface Shell {
  file: string;
  args(command: string): string[];
  /** cmd.exe parses its own command line; Node must not re-quote it. */
  verbatim?: boolean;
}

let shell: Shell | undefined;

/**
 * The shell Bash runs commands with. Unix: bash, else sh. Windows: Git Bash
 * when it can be found (models write POSIX shell, and it's what Claude Code
 * requires there too), skipping System32's bash.exe, which is WSL and would
 * run in a different filesystem; otherwise cmd.exe.
 */
export function resolveShell(): Shell {
  if (shell) return shell;
  if (process.platform !== 'win32') {
    const file = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    return (shell = { file, args: c => ['-c', c] });
  }
  const isWslShim = (p: string) => /\\(system32|windowsapps)\\/i.test(p);
  const gitBash = findOnPath('bash', isWslShim)
    ?? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
      .filter((d): d is string => !!d)
      .map(d => path.join(d, 'Git', 'bin', 'bash.exe'))
      .find(p => existsSync(p));
  if (gitBash) return (shell = { file: gitBash, args: c => ['-c', c] });
  return (shell = { file: process.env.ComSpec ?? 'cmd.exe', args: c => ['/d', '/s', '/c', `"${c}"`], verbatim: true });
}

export const bashTool: BuiltinTool = {
  spec: {
    name: 'Bash',
    description:
      'Runs a shell command in the working directory and returns its output (stdout, then stderr, then the exit ' +
      'code if it is not 0). Commands run with bash (on Windows, Git Bash when installed, else cmd.exe), with no ' +
      `stdin. timeout is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}); a command that ` +
      'runs longer is killed. Long output is truncated in the middle. Prefer Read, Grep and Glob over cat, grep ' +
      'and find.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: `Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS})` },
        description: { type: 'string', description: 'A short description of what this command does, in 5-10 words' },
      },
      required: ['command'],
    },
    _serverId: '',
    builtin: true,
  },

  async run(input, ctx) {
    const command = reqString(input, 'command', { allowEmpty: false });
    const requested = optNumber(input, 'timeout');
    const timeoutMs = requested && requested > 0 ? Math.min(requested, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

    const sh = resolveShell();
    const stdout = new HeadTail(MAX_OUTPUT_CHARS);
    const stderr = new HeadTail(MAX_OUTPUT_CHARS);
    let interrupted = false;
    let aborted = false;
    if (ctx.signal?.aborted) throw new ToolError('The run was interrupted before the command started.');

    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(sh.file, sh.args(command), {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: sh.verbatim,
        // Its own process group on Unix, so a timeout can kill the whole tree.
        detached: process.platform !== 'win32',
      });
      if (child.pid !== undefined) running.add(child.pid);
      child.stdout.setEncoding('utf8').on('data', (d: string) => stdout.push(d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => stderr.push(d));

      let settled = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        if (child.pid !== undefined) running.delete(child.pid);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ code, signal });
      };
      const timer = setTimeout(() => {
        interrupted = true;
        killTree(child.pid);
      }, timeoutMs);
      // Ctrl+C / SIGTERM on the run stops the command too.
      const onAbort = () => {
        interrupted = true;
        aborted = true;
        killTree(child.pid);
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        if (child.pid !== undefined) running.delete(child.pid);
        reject(new ToolError(`Could not start ${sh.file}: ${err.message}`));
      });
      child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), PIPE_GRACE_MS));
      child.on('close', (code, signal) => finish(code, signal));
    });

    const out = stdout.toString();
    const err = stderr.toString();
    const parts = [out.replace(/\n$/, ''), err.replace(/\n$/, '')].filter(Boolean);
    if (aborted) parts.push('Command was interrupted and killed.');
    else if (interrupted) parts.push(`Command timed out after ${timeoutMs} ms and was killed.`);
    else if (code !== 0) parts.push(code === null ? `Killed by signal ${signal}` : `Exit code ${code}`);

    return {
      content: parts.join('\n') || '(no output)',
      isError: interrupted || code !== 0,
      structured: { stdout: out, stderr: err, interrupted },
    };
  },
};

/**
 * Commands still running. If the process exits anyway (a forced exit after an
 * interrupt), they would be left behind as orphans in their own process
 * group, so the exit hook kills them synchronously.
 */
const running = new Set<number>();
process.on('exit', () => {
  for (const pid of running) killTreeSync(pid);
});

function killTreeSync(pid: number) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** Kill a process and everything it started. */
function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
