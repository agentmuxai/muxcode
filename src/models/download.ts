import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { muxHome } from '../llama-server/acquire.js';
import type { CatalogModel } from './catalog.js';
import { ggufUrl } from './catalog.js';

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  pct: number;
}

export async function downloadModel(
  model: CatalogModel,
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  const modelsDir = path.join(muxHome(), 'models');
  mkdirSync(modelsDir, { recursive: true });

  const fileName = model.file.split('/').pop()!;
  const destPath = path.join(modelsDir, fileName);
  const tmpPath = destPath + '.tmp';

  if (existsSync(destPath)) {
    if (model.sha256 && !(await verifySha256(destPath, model.sha256))) {
      process.stderr.write(`[mux] Checksum mismatch for ${fileName}, re-downloading\n`);
      unlinkSync(destPath);
    } else {
      return destPath;
    }
  }

  // Resume support: check existing .tmp size
  let resumeFrom = 0;
  if (existsSync(tmpPath)) {
    resumeFrom = statSync(tmpPath).size;
  }

  const url = ggufUrl(model);
  const headers: Record<string, string> = {};
  if (resumeFrom > 0) {
    headers['Range'] = `bytes=${resumeFrom}-`;
  }

  let res = await fetch(url, { headers });

  // If we requested a range but got 200 (server ignored Range), abort the
  // connection to avoid leaking the HTTP body, then restart from zero.
  if (resumeFrom > 0 && res.status === 200) {
    if (res.body) await res.body.cancel();
    resumeFrom = 0;
    res = await fetch(url);
  }

  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  }

  const contentLength = res.headers.get('content-length');
  const totalBytes = contentLength
    ? Number(contentLength) + resumeFrom
    : model.sizeGb * 1024 * 1024 * 1024;

  const writer = createWriteStream(tmpPath, { flags: resumeFrom > 0 ? 'a' : 'w' });
  const hash = createHash('sha256');

  let bytesDownloaded = resumeFrom;
  if (resumeFrom > 0) {
    // Pre-feed existing bytes into hash so final digest covers full file
    const { createReadStream } = await import('fs');
    await new Promise<void>((resolve, reject) => {
      createReadStream(tmpPath)
        .on('data', (chunk: string | Buffer) => hash.update(chunk))
        .on('end', resolve)
        .on('error', reject);
    });
  }

  if (!res.body) throw new Error('No response body');

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    writer.write(chunk);
    hash.update(chunk);
    bytesDownloaded += chunk.length;
    onProgress?.({
      bytesDownloaded,
      totalBytes,
      pct: totalBytes > 0 ? Math.min(100, (bytesDownloaded / totalBytes) * 100) : 0,
    });
  }

  await new Promise<void>((resolve, reject) => {
    writer.end(err => (err ? reject(err) : resolve()));
  });

  if (model.sha256) {
    const digest = hash.digest('hex');
    if (digest !== model.sha256) {
      unlinkSync(tmpPath);
      throw new Error(`SHA256 mismatch: expected ${model.sha256}, got ${digest}`);
    }
  }

  renameSync(tmpPath, destPath);

  const metaPath = destPath + '.json';
  writeFileSync(metaPath, JSON.stringify({
    id: model.id,
    name: model.name,
    sizeGb: model.sizeGb,
    sha256: model.sha256 ?? null,
    downloadedAt: new Date().toISOString(),
  }, null, 2));

  return destPath;
}

export function removeModel(modelPath: string): void {
  if (existsSync(modelPath)) unlinkSync(modelPath);
  const metaPath = modelPath + '.json';
  if (existsSync(metaPath)) unlinkSync(metaPath);
}

async function verifySha256(filePath: string, expected: string): Promise<boolean> {
  const { createReadStream } = await import('fs');
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('hex') === expected))
      .on('error', reject);
  });
}
