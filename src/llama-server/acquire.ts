import {
  existsSync, mkdirSync, chmodSync,
  writeFileSync, readFileSync, renameSync, unlinkSync,
  createWriteStream,
} from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';
import { detectPlatform, assetName, APPROX_SIZES, platformKey } from './platform.js';

const GITHUB_RELEASES_API =
  'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

// Pinned build — updated periodically after smoke testing.
// Override with LLAMA_SERVER_BUILD env var.
const DEFAULT_BUILD = 'b9558';

export function muxHome(): string {
  return process.env.MUX_HOME ?? path.join(os.homedir(), '.mux');
}

const BIN_DIR = path.join(muxHome(), 'bin');

export function llamaServerBinPath(): string {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.join(BIN_DIR, exe);
}

const VERSION_FILE = path.join(BIN_DIR, 'llama-server.version');
const LASTCHECK_FILE = path.join(BIN_DIR, 'llama-server.lastcheck');

export type ProgressFn = (pct: number, label: string) => void;

export async function ensureLlamaServer(onProgress?: ProgressFn): Promise<string> {
  const binPath = llamaServerBinPath();
  const platform = detectPlatform();

  // Use pinned build unless env override
  const pinnedBuild = process.env.LLAMA_SERVER_BUILD ?? DEFAULT_BUILD;

  // Already installed at the right version?
  const installed = readVersionFile();
  if (installed === pinnedBuild && existsSync(binPath)) {
    return binPath;
  }

  // Determine build to fetch (pinned or latest)
  const build = await resolveBuild(pinnedBuild);
  const asset = assetName(build, platform);
  const approxSize = APPROX_SIZES[platformKey(platform)] ?? '?';

  onProgress?.(0, `Downloading llama-server ${build} (${approxSize})`);

  mkdirSync(BIN_DIR, { recursive: true });

  // Get download URL from GitHub releases API
  const url = await resolveAssetUrl(build, asset);
  // Use platform-appropriate extension: Expand-Archive on Windows 5.1 requires .zip
  const tmpExt = process.platform === 'win32' ? '.zip' : '.tar.gz';
  const tmpArchive = path.join(BIN_DIR, `llama-server${tmpExt}.downloading`);

  await downloadWithProgress(url, tmpArchive, (pct) => {
    onProgress?.(Math.round(pct * 0.9), `Downloading llama-server ${build} (${approxSize})`);
  });

  onProgress?.(90, 'Extracting llama-server binary...');
  try {
    await extractServerBinary(tmpArchive, BIN_DIR);
  } finally {
    if (existsSync(tmpArchive)) unlinkSync(tmpArchive);
  }

  if (process.platform !== 'win32') {
    chmodSync(binPath, 0o755);
  }

  // Atomic version write
  const tmpVersion = VERSION_FILE + '.tmp';
  writeFileSync(tmpVersion, build, 'utf8');
  renameSync(tmpVersion, VERSION_FILE);

  writeFileSync(LASTCHECK_FILE, new Date().toISOString(), 'utf8');

  onProgress?.(100, `llama-server ${build} ready`);
  return binPath;
}

async function resolveBuild(pinned: string): Promise<string> {
  if (pinned !== 'latest') return pinned;

  // Check GitHub API for latest tag
  const res = await fetch(GITHUB_RELEASES_API, {
    headers: { 'User-Agent': 'mux-code' },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json() as { tag_name: string };
  return data.tag_name;
}

async function resolveAssetUrl(build: string, asset: string): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${build}`,
    { headers: { 'User-Agent': 'mux-code' } }
  );
  if (!res.ok) throw new Error(`Could not find llama.cpp release ${build}`);
  const data = await res.json() as { assets: { name: string; browser_download_url: string }[] };

  const found = data.assets.find(a => a.name === asset);
  if (!found) {
    const available = data.assets.map(a => a.name).join(', ');
    throw new Error(
      `No asset "${asset}" in release ${build}.\nAvailable: ${available}`
    );
  }
  return found.browser_download_url;
}

async function downloadWithProgress(
  url: string,
  dest: string,
  onProgress: (pct: number) => void
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length') ?? 0);
  let downloaded = 0;

  const writer = createWriteStream(dest);
  let streamErr: Error | null = null;
  writer.once('error', (err) => { streamErr = err as Error; });
  const body = res.body!;

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    if (streamErr) throw streamErr;
    const canContinue = writer.write(chunk);
    downloaded += chunk.length;
    if (total > 0) onProgress(downloaded / total);
    if (!canContinue) {
      await new Promise<void>(r => writer.once('drain', r));
      if (streamErr) throw streamErr;
    }
  }
  if (streamErr) throw streamErr;

  await new Promise<void>((resolve, reject) => {
    writer.end((err: Error | null) => err ? reject(err) : resolve());
  });
}

async function extractServerBinary(archivePath: string, destDir: string): Promise<void> {
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const destBin = path.join(destDir, exeName);

  if (process.platform !== 'win32') {
    // List archive to find the binary's exact path — avoids GNU-only
    // flags (--wildcards, --no-anchored) that BSD tar (macOS) rejects.
    const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', stdio: 'pipe' });
    const entry = listing.split('\n').find(l => l === exeName || l.endsWith(`/${exeName}`));
    if (!entry) throw new Error(`${exeName} not found in archive`);
    const depth = entry.trim().split('/').length - 1;
    execFileSync('tar', [
      '-xzf', archivePath,
      '-C', destDir,
      `--strip-components=${depth}`,
      entry.trim(),
    ], { stdio: 'pipe' });
  } else {
    // Windows: .zip — use PowerShell to expand, then find+move the binary.
    // Paths are passed via env vars to avoid single-quote injection in -Command strings.
    const extractResult = spawnSync('powershell', [
      '-Command',
      'Expand-Archive -LiteralPath $env:MUXCODE_ARCHIVE -DestinationPath $env:MUXCODE_DESTDIR -Force',
    ], { env: { ...process.env, MUXCODE_ARCHIVE: archivePath, MUXCODE_DESTDIR: destDir }, stdio: 'pipe' });
    if (extractResult.status !== 0) {
      throw new Error(
        `Expand-Archive failed (exit ${extractResult.status}): ` +
        (extractResult.stderr?.toString().trim() ?? 'unknown error'),
      );
    }
    if (!existsSync(destBin)) {
      // Binary may be nested; use PowerShell to locate and move it.
      const result = spawnSync('powershell', [
        '-Command',
        `Get-ChildItem -LiteralPath $env:MUXCODE_DESTDIR -Recurse -Filter '${exeName}' | Select-Object -First 1 -ExpandProperty FullName`,
      ], { env: { ...process.env, MUXCODE_DESTDIR: destDir }, stdio: 'pipe', encoding: 'utf8' });
      const found = result.stdout.trim();
      if (!found) throw new Error(`${exeName} not found in extracted archive`);
      if (found !== destBin) renameSync(found, destBin);
    }
  }
}

function readVersionFile(): string | null {
  try { return readFileSync(VERSION_FILE, 'utf8').trim(); }
  catch { return null; }
}
