import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { muxHome } from '../llama-server/acquire.js';

export interface InstalledModel {
  name: string;
  path: string;
  sizeBytes: number;
  downloadedAt?: string;
}

interface ModelSidecar {
  id?: string;
  name?: string;
  sizeGb?: number;
  sha256?: string | null;
  downloadedAt?: string;
}

export function listInstalled(): InstalledModel[] {
  const modelsDir = path.join(muxHome(), 'models');

  let files: string[];
  try {
    files = readdirSync(modelsDir);
  } catch {
    return [];
  }

  return files
    .filter(f => {
      if (!f.endsWith('.gguf')) return false;
      try { return statSync(path.join(modelsDir, f)).isFile(); } catch { return false; }
    })
    .map(f => {
      const fullPath = path.join(modelsDir, f);
      const stat = statSync(fullPath);
      const metaPath = fullPath + '.json';

      let sidecar: ModelSidecar | undefined;
      if (existsSync(metaPath)) {
        try {
          sidecar = JSON.parse(readFileSync(metaPath, 'utf8')) as ModelSidecar;
        } catch {
          // ignore malformed sidecar
        }
      }

      const name = sidecar?.id ?? f.replace(/\.gguf$/, '');

      return {
        name,
        path: fullPath,
        sizeBytes: stat.size,
        ...(sidecar?.downloadedAt ? { downloadedAt: sidecar.downloadedAt } : {}),
      };
    });
}
