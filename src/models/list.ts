import { readdirSync, statSync } from 'fs';
import path from 'path';
import { muxHome } from '../llama-server/acquire.js';

export interface InstalledModel {
  name: string;
  path: string;
  sizeBytes: number;
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
    .filter(f => f.endsWith('.gguf'))
    .map(f => {
      const fullPath = path.join(modelsDir, f);
      const stat = statSync(fullPath);
      return {
        name: f.replace(/\.gguf$/, '').replace(/-/g, ':'),
        path: fullPath,
        sizeBytes: stat.size,
      };
    });
}
