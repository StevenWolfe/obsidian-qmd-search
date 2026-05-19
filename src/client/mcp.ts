const http = require('http') as typeof import('http');

import { log } from '../util/log';

import type { QmdClient } from './base';
import type {
  QmdResult,
  RawQmdResult,
  QmdDocument,
  QmdStatus,
  SearchOptions,
} from './types';
import { normalizeResult } from './types';
import {
  readPidFile,
  isProcessAlive,
  spawnDaemon,
  waitForEndpoint,
} from '../util/daemon';
import type { ChildProcess } from 'child_process';

// Sub-query type for the MCP `query` tool
interface SubQuery {
  type: 'lex' | 'vec' | 'hyde';
  query: string;
}

interface JsonRpcResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: { message: string };
}

export class McpQmdClient implements QmdClient {
  private daemon: ChildProcess | null = null;
  private spawned = false;
  private initAbort: AbortController | null = null;
  private sessionId: string | null = null;

  constructor(
    private readonly binary: string = 'qmd',
    private readonly port: number = 8181,
  ) {}

  async init(): Promise<void> {
    this.initAbort = new AbortController();

    const fs = require('fs') as typeof import('fs');
    // Validate binary before spawning — spawning a non-existent file in
    // Electron's renderer corrupts IPC channel state.
    if ((this.binary.includes('/') || this.binary.includes('\\')) && !fs.existsSync(this.binary)) {
      throw new Error(`qmd binary not found: ${this.binary}`);
    }

    const existingPid = readPidFile();
    if (existingPid === null || !isProcessAlive(existingPid)) {
      this.daemon = spawnDaemon(this.binary, this.port);
      this.spawned = true;
      log.debug(`spawned MCP daemon on port ${this.port}, waiting for endpoint…`);
    }

    await waitForEndpoint(this.port, this.initAbort.signal);
    log.debug(`MCP daemon ready on port ${this.port}`);

    // MCP requires an initialize handshake; response carries the session ID
    await this.mcpInitialize();
  }

  private mcpInitialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'obsidian-qmd-search', version: '0.1.0' },
        },
        id: 0,
      });

      const req = http.request(
        {
          hostname: '127.0.0.1', port: this.port, path: '/mcp', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const sid = res.headers['mcp-session-id'];
            if (sid) {
              this.sessionId = Array.isArray(sid) ? sid[0] : sid;
              log.debug('MCP session ID:', this.sessionId);
              resolve();
            } else {
              reject(new Error('MCP initialize: no session ID in response'));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private rpc(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: tool, arguments: args },
        id: 1,
      });

      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

      const req = http.request(
        { hostname: '127.0.0.1', port: this.port, path: '/mcp', method: 'POST', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              if (!res.statusCode || res.statusCode >= 400) {
                reject(new Error(`MCP HTTP error ${res.statusCode}: ${text}`));
                return;
              }
              const json = JSON.parse(text) as JsonRpcResponse;
              if (json.error) { reject(new Error(`MCP error: ${json.error.message}`)); return; }
              const content = json.result?.content;
              if (!content?.length) { resolve(null); return; }
              const textPart = content.find((c) => c.type === 'text');
              if (!textPart?.text) { resolve(null); return; }
              try {
                resolve(JSON.parse(textPart.text));
              } catch (parseErr) {
                log.error('MCP result JSON parse failed, raw text:', textPart.text);
                reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
              }
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        },
      );
      req.on('error', (e) => { log.error('MCP rpc error:', e.message); reject(e); });
      req.write(body);
      req.end();
    });
  }

  async search(opts: SearchOptions): Promise<QmdResult[]> {
    // Build typed sub-queries based on mode
    const searches: SubQuery[] = [];
    if (opts.mode === 'keyword' || opts.mode === 'hybrid') {
      searches.push({ type: 'lex', query: opts.query });
    }
    if (opts.mode === 'semantic' || opts.mode === 'hybrid') {
      searches.push({ type: 'vec', query: opts.query });
    }

    const args: Record<string, unknown> = { searches };
    if (opts.collection) args['collections'] = [opts.collection];
    if (opts.intent) args['intent'] = opts.intent;
    if (opts.limit) args['limit'] = opts.limit;
    if (opts.noRerank) args['no_rerank'] = true;
    if (opts.candidateLimit) args['candidates'] = opts.candidateLimit;
    if (opts.minScore) args['min_score'] = opts.minScore;

    const result = (await this.rpc('query', args)) as RawQmdResult[] | { results?: RawQmdResult[] } | null;
    const items = Array.isArray(result) ? result : (result?.results ?? []);
    return items.map(normalizeResult);
  }

  async get(pathOrDocid: string): Promise<QmdDocument> {
    const result = await this.rpc('get', { file: pathOrDocid });
    return result as QmdDocument;
  }

  async status(): Promise<QmdStatus> {
    const result = (await this.rpc('status', {})) as Partial<QmdStatus> | null;
    return {
      healthy: result?.healthy ?? true,
      message: result?.message ?? 'OK',
      collections: result?.collections ?? [],
    };
  }

  async dispose(): Promise<void> {
    this.initAbort?.abort();
    this.sessionId = null;
    if (this.spawned && this.daemon) {
      this.daemon.kill();
      this.daemon = null;
    }
  }
}
