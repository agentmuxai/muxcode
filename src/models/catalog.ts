import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { muxHome } from '../llama-server/acquire.js';

export interface CatalogModel {
  id: string;
  name: string;
  description: string;
  repo: string;
  file: string;
  sizeGb: number;
  sha256?: string;
  tags: string[];
}

interface Catalog {
  version: number;
  models: CatalogModel[];
}

const CATALOG_URL = 'https://cdn.a5af.com/mux-code/catalog.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function getCatalog(): Promise<CatalogModel[]> {
  const cachePath = path.join(muxHome(), 'catalog-cache.json');

  // Try local cache first
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { fetchedAt: number; catalog: Catalog };
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.catalog.models;
      }
    } catch {
      // fall through to fetch
    }
  }

  // Try remote
  try {
    const res = await fetch(CATALOG_URL);
    if (res.ok) {
      const catalog = await res.json() as Catalog;
      const dir = path.join(muxHome());
      mkdirSync(dir, { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), catalog }));
      return catalog.models;
    }
  } catch {
    // fall through to bundled
  }

  // Fall back to bundled catalog
  return getBundledCatalog();
}

export function getBundledCatalog(): CatalogModel[] {
  // Resolve catalog.json relative to this module's package root
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(__dirname, '../../catalog.json'),
    path.join(process.cwd(), 'catalog.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf8')) as Catalog;
        return data.models;
      } catch {
        // try next
      }
    }
  }
  return [];
}

export function findModel(idOrName: string, models: CatalogModel[]): CatalogModel | undefined {
  const lower = idOrName.toLowerCase();
  return models.find(m =>
    m.id === idOrName ||
    m.id.toLowerCase() === lower ||
    m.name.toLowerCase().includes(lower)
  );
}

export function ggufUrl(model: CatalogModel): string {
  return `https://huggingface.co/${model.repo}/resolve/main/${model.file}`;
}
