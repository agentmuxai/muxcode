import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { ensureLlamaServer } from './acquire.js';
import type { ProgressFn } from './acquire.js';

interface ServerInstance {
  modelPath: string;
  port: number;
  proc: ChildProcess;
  baseUrl: string;
}

let current: ServerInstance | null = null;

export async function getServerUrl(
  modelPath: string,
  onProgress?: ProgressFn
): Promise<string> {
  if (!existsSync(modelPath)) {
    throw new Error(`Model file not found: ${modelPath}`);
  }

  // Reuse running server if same model
  if (current?.modelPath === modelPath) {
    const alive = await checkHealth(current.baseUrl, 500);
    if (alive) return current.baseUrl;
    // Server unhealthy — kill it before restarting
    current.proc.kill('SIGTERM');
    current = null;
  }

  // Stop previous server if different model
  if (current) {
    await stopServer();
  }

  const binPath = await ensureLlamaServer(onProgress);
  const port = await findFreePort(8080);
  const meta = readModelMeta(modelPath);
  const ctxSize = meta?.context_window ?? 4096;

  const proc = spawn(binPath, [
    '--model', modelPath,
    '--port', String(port),
    '--host', '127.0.0.1',
    '--ctx-size', String(ctxSize),
    '--parallel', '1',
    '--log-disable',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  proc.on('error', (err) => {
    process.stderr.write(`[mux-code] llama-server error: ${err.message}\n`);
    if (current?.proc === proc) current = null;
  });

  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[mux-code] llama-server exited with code ${code}\n`);
    }
    // Only clear current if this is still the active process — avoids
    // nulling the reference when a replacement server has already started.
    if (current?.proc === proc) current = null;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  current = { modelPath, port, proc, baseUrl };

  await waitForHealth(proc, baseUrl, 45_000);
  return baseUrl;
}

async function waitForHealth(proc: ChildProcess, baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Bail early if the process has already exited
    if (proc.exitCode !== null) {
      current = null;
      throw new Error(`llama-server exited unexpectedly (code ${proc.exitCode}) during startup`);
    }
    if (await checkHealth(baseUrl, 300)) return;
    await sleep(300);
  }
  await stopServer();
  throw new Error(
    `llama-server did not start within ${timeoutMs / 1000}s. ` +
    `The model may require more RAM than available.`
  );
}

async function checkHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/health`, { signal: ac.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function stopServer(): Promise<void> {
  if (!current) return;
  const proc = current.proc;
  current = null;
  proc.kill('SIGTERM');
  await sleep(800);
  if (!proc.killed) proc.kill('SIGKILL');
}

async function findFreePort(startFrom: number): Promise<number> {
  for (let port = startFrom; port < startFrom + 100; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${startFrom}–${startFrom + 100}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
    server.on('error', () => resolve(false));
  });
}

function readModelMeta(modelPath: string): { context_window?: number } | null {
  const metaPath = modelPath + '.json';
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Ensure clean shutdown when mux-code exits
process.on('exit', () => {
  if (current) current.proc.kill('SIGKILL');
});

process.on('SIGINT', () => {
  stopServer().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  stopServer().finally(() => process.exit(0));
});
