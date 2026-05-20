const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const https = require('https') as typeof import('https');
const { execFile } = require('child_process') as typeof import('child_process');

import { buildEnv } from './env';

// ── Event schema ────────────────────────────────────────────────────────────

export type TelemetryEvent =
  | { kind: 'command_timing'; command: string; transport: 'cli' | 'mcp'; mode?: string; duration_ms: number; success: boolean; result_count?: number }
  | { kind: 'version_snapshot'; plugin_version: string; qmd_version: string; node_version: string; electron_version: string; os_platform: string; os_arch: string; cpu_cores: number }
  | { kind: 'index_snapshot'; total_docs: number; total_vectors: number; collection_count: number }
  | { kind: 'hardware_snapshot'; cpu_cores: number; gpu_info?: string; gpu_vram?: string; gpu_device?: string };

type RingEntry = { ts: string } & TelemetryEvent;

// ── Snapshot types (for diagnostics report) ─────────────────────────────────

interface VersionSnap {
  plugin_version: string;
  qmd_version: string;
  node_version: string;
  electron_version: string;
  os_platform: string;
  os_arch: string;
  cpu_cores: number;
}

interface HardwareSnap {
  cpu_cores: number;
  gpu_info?: string;
  gpu_vram?: string;
  gpu_device?: string;
}

interface IndexSnap {
  total_docs: number;
  total_vectors: number;
  collection_count: number;
}

// ── Settings snapshot (caller-provided, no circular dep on settings.ts) ──────

export interface DiagnosticsSettingsSnapshot {
  transportMode: string;
  defaultSearchMode: string;
  noRerank: boolean;
  indexName: string;
  logLevel: string;
  telemetryEnabled: boolean;
}

// ── Module state ─────────────────────────────────────────────────────────────

let _enabled = false;
let _versionSnapshotEmitted = false;
let _hardwareSnapshotEmitted = false;
let _lastIndexSnapshotDate = '';

// Cached for diagnostics report — populated regardless of _enabled
let _versionSnap: VersionSnap | null = null;
let _hardwareSnap: HardwareSnap | null = null;
let _indexSnap: IndexSnap | null = null;

// In-memory ring: always populated (no disk write), used for diagnostics export
const RING_MAX = 100;
const _ring: RingEntry[] = [];

// ── Core API ─────────────────────────────────────────────────────────────────

export function setTelemetryEnabled(v: boolean): void {
  _enabled = v;
  if (v) {
    // Re-enable resets per-session emission flags so fresh snapshots are written
    _versionSnapshotEmitted = false;
    _hardwareSnapshotEmitted = false;
  }
}

export function isTelemetryEnabled(): boolean {
  return _enabled;
}

function telemetryPath(): string {
  return path.join(os.homedir(), '.cache', 'qmd', 'telemetry.jsonl');
}

export function record(event: TelemetryEvent): void {
  const entry = { ts: new Date().toISOString(), ...event };

  // Ring is always updated (in-memory only, used for diagnostics)
  if (_ring.length >= RING_MAX) _ring.shift();
  _ring.push(entry);

  // Disk write is opt-in
  if (!_enabled) return;
  const dest = telemetryPath();
  try {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(dest, JSON.stringify(entry) + '\n');
  } catch {
    // telemetry must never surface errors to the user
  }
}

/**
 * Wrap an async operation with timing. Emits a command_timing event.
 * Zero overhead when telemetry is disabled and user hasn't opted in.
 */
export async function timed<T>(
  meta: { command: string; transport: 'cli' | 'mcp'; mode?: string },
  fn: () => Promise<T>,
  getResultCount?: (result: T) => number,
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    record({
      kind: 'command_timing',
      ...meta,
      duration_ms: Date.now() - t0,
      success: true,
      ...(getResultCount !== undefined ? { result_count: getResultCount(result) } : {}),
    });
    return result;
  } catch (err) {
    record({ kind: 'command_timing', ...meta, duration_ms: Date.now() - t0, success: false });
    throw err;
  }
}

// ── Snapshot emitters ─────────────────────────────────────────────────────────

/**
 * Capture version info once per session. Synchronous parts resolve immediately;
 * qmd version is filled in async via execFile. Records to JSONL only if enabled.
 */
export function emitVersionSnapshot(binary: string, pluginVersion: string): void {
  if (_versionSnapshotEmitted) return;
  _versionSnapshotEmitted = true;

  // Capture synchronous parts now so the diagnostics report is always populated
  _versionSnap = {
    plugin_version: pluginVersion,
    qmd_version: 'resolving…',
    node_version: process.versions.node ?? 'unknown',
    electron_version: process.versions.electron ?? 'unknown',
    os_platform: os.platform(),
    os_arch: os.arch(),
    cpu_cores: os.cpus().length,
  };

  execFile(binary, ['--version'], { timeout: 5000, env: buildEnv() }, (err, stdout) => {
    if (_versionSnap) _versionSnap.qmd_version = err ? 'unknown' : stdout.trim();
    if (_enabled) record({ kind: 'version_snapshot', ..._versionSnap! });
  });
}

/** Record daily index stats. Caches for diagnostics regardless of _enabled. */
export function maybeEmitIndexSnapshot(totalDocs: number, totalVectors: number, collectionCount: number): void {
  _indexSnap = { total_docs: totalDocs, total_vectors: totalVectors, collection_count: collectionCount };

  if (!_enabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (_lastIndexSnapshotDate === today) return;
  _lastIndexSnapshotDate = today;
  record({ kind: 'index_snapshot', ..._indexSnap });
}

/** Record hardware info once per session. Caches for diagnostics regardless of _enabled. */
export function emitHardwareSnapshot(gpuInfo?: string, gpuVram?: string, gpuDevice?: string): void {
  _hardwareSnap = {
    cpu_cores: os.cpus().length,
    ...(gpuInfo   ? { gpu_info:   gpuInfo   } : {}),
    ...(gpuVram   ? { gpu_vram:   gpuVram   } : {}),
    ...(gpuDevice ? { gpu_device: gpuDevice } : {}),
  };

  if (!_enabled || _hardwareSnapshotEmitted) return;
  _hardwareSnapshotEmitted = true;
  record({ kind: 'hardware_snapshot', ..._hardwareSnap });
}

// ── Diagnostics report ────────────────────────────────────────────────────────

/** Build a diagnostics report JSON string from cached state + recent ring events. */
export function buildDiagnosticsReport(settings: DiagnosticsSettingsSnapshot): string {
  return JSON.stringify(
    {
      generated: new Date().toISOString(),
      plugin:   _versionSnap  ?? { note: 'not yet collected — open Settings once to populate' },
      system:   _hardwareSnap ?? { note: 'not yet collected' },
      index:    _indexSnap    ?? { note: 'not yet collected' },
      settings: {
        transport_mode:      settings.transportMode,
        default_search_mode: settings.defaultSearchMode,
        no_rerank:           settings.noRerank,
        index_name:          settings.indexName || '(default)',
        log_level:           settings.logLevel,
        telemetry_enabled:   settings.telemetryEnabled,
      },
      recent_events: _ring.slice(-20).map((e) => ({ ...e })),
    },
    null,
    2,
  );
}

/**
 * Post a report to paste.rs (anonymous, no auth).
 * Returns the paste URL on success.
 * Note: paste.rs URLs are not indexed but ARE publicly accessible to anyone with the link.
 */
export function postReport(content: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(content, 'utf8');
    const req = https.request(
      {
        hostname: 'paste.rs',
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': data.byteLength,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').trim();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && body.startsWith('http')) {
            resolve(body);
          } else {
            reject(new Error(`paste.rs responded ${res.statusCode}: ${body.slice(0, 120)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
