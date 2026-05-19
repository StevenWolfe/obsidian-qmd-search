// Normalized result — path and collection are extracted from the raw URI field.
export interface QmdResult {
  title: string;
  path: string;       // relative path within the collection (e.g. "notes/file.md")
  collection: string; // collection name (e.g. "my-vault")
  score: number;
  snippet: string;
  docid: string;
  line?: number;
}

// Raw shape returned by `qmd search/vsearch/query --json` (bare array)
export interface RawQmdResult {
  docid: string;
  score: number;
  file: string;       // "qmd://collection-name/relative/path.md"
  title?: string;
  snippet?: string;
  line?: number;
}

// Normalise a raw CLI/MCP result into QmdResult
export function normalizeResult(raw: RawQmdResult): QmdResult {
  const uriMatch = raw.file.match(/^qmd:\/\/([^/]+)\/(.+)$/);
  return {
    docid: raw.docid,
    score: raw.score,
    title: raw.title ?? '',
    snippet: raw.snippet ?? '',
    line: raw.line,
    collection: uriMatch ? uriMatch[1] : '',
    path: uriMatch ? uriMatch[2] : raw.file,
  };
}

export interface QmdDocument {
  title: string;
  path: string;
  collection: string;
  content: string;
  docid: string;
}

export interface QmdCollectionStatus {
  name: string;
  docCount: number;
  lastIndexed?: string;
}

export interface QmdStatus {
  healthy: boolean;
  message: string;
  collections: QmdCollectionStatus[];
  // Extended fields parsed from qmd status (CLI transport only)
  indexPath?: string;
  indexSize?: string;
  totalDocs?: number;
  totalVectors?: number;
  astChunkingActive?: boolean;
  astLanguages?: string[];
  embeddingModel?: string;
  rerankingModel?: string;
  generationModel?: string;
  gpuInfo?: string;
  gpuDevice?: string;
  gpuVram?: string;
  cpuCores?: string;
}

export type PluginStatus =
  | { kind: 'unresolved' }
  | { kind: 'empty' }
  | { kind: 'idle'; docs: number; collections: number; embeddings: number; lastIndexed?: string }
  | { kind: 'indexing'; done: number; total: number }
  | { kind: 'error'; detail: string; code: 'binary_missing' | 'index_corrupt' | 'qmd_crash' }
  | { kind: 'transient'; results: number; ms: number };

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface SearchOptions {
  query: string;
  mode: SearchMode;
  collection?: string;
  intent?: string;
  limit?: number;
  noRerank?: boolean;
  candidateLimit?: number;
  minScore?: number;
}
