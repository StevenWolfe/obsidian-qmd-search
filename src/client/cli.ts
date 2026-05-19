const { execFile } = require('child_process') as typeof import('child_process');

import type { QmdClient } from './base';
import type {
  QmdResult,
  RawQmdResult,
  QmdDocument,
  QmdStatus,
  SearchOptions,
} from './types';
import { normalizeResult } from './types';
import { log } from '../util/log';
import { buildEnv } from '../util/env';

const MODE_CMD: Record<SearchOptions['mode'], string> = {
  keyword: 'search',
  semantic: 'vsearch',
  hybrid: 'query',
};

// Strip ANSI/VT100 escape sequences — qmd emits cursor-hide/show codes
// (\x1b[?25l, \x1b[?25h) to stderr when it thinks it's in a TTY, which
// Node embeds verbatim into execFile error messages.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function runQmd(binary: string, args: string[]): Promise<string> {
  log.debug('run:', binary, args.join(' '));
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, env: buildEnv() }, (err, stdout, stderr) => {
      if (err) {
        // Prefer stderr content over err.message — err.message embeds the full
        // "Command failed: /path/to/binary arg1 arg2…\n<stderr>" which is noisy.
        const detail = stderr ? stripAnsi(stderr).trim() : '';
        const clean = detail || stripAnsi(err.message);
        log.error('command failed (exit %s):', err.code, clean);
        reject(new Error(clean));
      } else {
        const cleanErr = stderr ? stripAnsi(stderr).trim() : '';
        if (cleanErr) log.warn('stderr:', cleanErr);
        log.debug('stdout (%d bytes):', stdout.length, stdout.slice(0, 500));
        resolve(stdout);
      }
    });
  });
}

function parseStatusText(raw: string): QmdStatus {
  log.debug('parseStatusText raw:\n', raw);
  const lines = raw.split('\n');
  const collections: QmdStatus['collections'] = [];

  const totalMatch = raw.match(/Total:\s+(\d+) files indexed/);
  const totalDocs = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  log.debug('totalMatch:', totalMatch?.[0] ?? '(none)');

  const vectorsMatch = raw.match(/Vectors:\s+(\d+) embedded/);
  const totalVectors = vectorsMatch ? parseInt(vectorsMatch[1], 10) : undefined;

  const indexPathMatch = raw.match(/^Index:\s+(.+)/m);
  const indexPath = indexPathMatch ? indexPathMatch[1].trim() : undefined;

  const indexSizeMatch = raw.match(/^Size:\s+(.+)/m);
  const indexSize = indexSizeMatch ? indexSizeMatch[1].trim() : undefined;

  const astStatusMatch = raw.match(/Status:\s+(\w+)/);
  const astChunkingActive = astStatusMatch ? astStatusMatch[1] === 'active' : undefined;

  const astLangMatch = raw.match(/Languages?:\s+(.+)/);
  const astLanguages = astLangMatch ? astLangMatch[1].trim().split(/,\s*/) : undefined;

  const lastPathSegment = (s: string): string => {
    const m = s.trim().match(/\/([^/]+)\s*$/);
    return m ? m[1] : s.trim();
  };

  const embeddingMatch = raw.match(/Embedding:\s+(.+)/);
  const embeddingModel = embeddingMatch ? lastPathSegment(embeddingMatch[1]) : undefined;

  const rerankingMatch = raw.match(/Reranking:\s+(.+)/);
  const rerankingModel = rerankingMatch ? lastPathSegment(rerankingMatch[1]) : undefined;

  const generationMatch = raw.match(/Generation:\s+(.+)/);
  const generationModel = generationMatch ? lastPathSegment(generationMatch[1]) : undefined;

  const gpuLineMatch = raw.match(/GPU:\s+(.+)/);
  const gpuInfo = gpuLineMatch ? gpuLineMatch[1].trim() : undefined;

  const devicesMatch = raw.match(/Devices:\s+(.+)/);
  const gpuDevice = devicesMatch ? devicesMatch[1].trim() : undefined;

  const vramMatch = raw.match(/VRAM:\s+(.+)/);
  const gpuVram = vramMatch ? vramMatch[1].trim() : undefined;

  const cpuMatch = raw.match(/CPU:\s+(.+)/);
  const cpuCores = cpuMatch ? cpuMatch[1].trim() : undefined;

  // Collection entries are indented 2 spaces followed by name + (qmd://...)
  // Child properties (Files:, Updated:) are indented 4+ spaces.
  for (let i = 0; i < lines.length; i++) {
    const collMatch = lines[i].match(/^ {2}(\S+)\s+\(qmd:\/\//);
    if (!collMatch) continue;

    const name = collMatch[1];
    let docCount = 0;
    let lastIndexed: string | undefined;

    for (let j = i + 1; j < lines.length && /^ {4}/.test(lines[j]); j++) {
      const filesMatch = lines[j].match(/Files:\s+(\d+)/);
      if (filesMatch) {
        docCount = parseInt(filesMatch[1], 10);
        const inline = lines[j].match(/\(updated (.+?)\)/);
        if (inline) lastIndexed = inline[1];
      }
      const updMatch = lines[j].match(/Updated:\s+(.+)/);
      if (updMatch) lastIndexed = updMatch[1].trim();
    }

    log.debug('collection parsed:', { name, docCount, lastIndexed });
    collections.push({ name, docCount, lastIndexed });
  }

  const result: QmdStatus = {
    healthy: true,
    message: `${totalDocs} doc${totalDocs !== 1 ? 's' : ''} indexed`,
    collections,
    indexPath,
    indexSize,
    totalDocs,
    totalVectors,
    astChunkingActive,
    astLanguages,
    embeddingModel,
    rerankingModel,
    generationModel,
    gpuInfo,
    gpuDevice,
    gpuVram,
    cpuCores,
  };
  log.debug('status result:', result);
  return result;
}

export class CliQmdClient implements QmdClient {
  constructor(
    private readonly binary: string = 'qmd',
    private readonly indexName: string = '',
  ) {
    log.debug('CliQmdClient created, binary:', binary, 'index:', indexName || '(default)');
  }

  private ix(): string[] {
    return this.indexName ? ['--index', this.indexName] : [];
  }

  async search(opts: SearchOptions): Promise<QmdResult[]> {
    const cmd = MODE_CMD[opts.mode];
    const args: string[] = [...this.ix(), cmd, opts.query, '--json'];

    if (opts.collection) args.push('-c', opts.collection);
    if (opts.limit) args.push('-n', String(opts.limit));
    if (opts.intent) args.push('--intent', opts.intent);
    if (opts.noRerank) args.push('--no-rerank');
    if (opts.candidateLimit) args.push('-C', String(opts.candidateLimit));
    if (opts.minScore) args.push('--min-score', String(opts.minScore));

    log.debug('search opts:', opts);
    const raw = await runQmd(this.binary, args);
    // Output is a bare JSON array, not {results: [...]}
    const parsed = JSON.parse(raw) as RawQmdResult[] | { results?: RawQmdResult[] };
    const items = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
    log.debug('search returned', items.length, 'results');
    return items.map(normalizeResult);
  }

  async get(pathOrDocid: string): Promise<QmdDocument> {
    // qmd get has no --json flag — returns raw document text
    const raw = await runQmd(this.binary, [...this.ix(), 'get', pathOrDocid]);
    return { title: pathOrDocid, path: pathOrDocid, collection: '', content: raw, docid: pathOrDocid };
  }

  async status(): Promise<QmdStatus> {
    // qmd status has no --json flag; parse the plain text output.
    const raw = await runQmd(this.binary, [...this.ix(), 'status']);
    return parseStatusText(raw);
  }

  async dispose(): Promise<void> {
    // no-op for CLI mode
  }
}
