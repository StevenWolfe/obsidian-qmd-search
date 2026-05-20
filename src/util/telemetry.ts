const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const { execFile } = require('child_process') as typeof import('child_process');

import { buildEnv } from './env';

export type TelemetryEvent =
  | { kind: 'command_timing'; command: string; transport: 'cli' | 'mcp'; mode?: string; duration_ms: number; success: boolean; result_count?: number }
  | { kind: 'version_snapshot'; plugin_version: string; qmd_version: string; node_version: string; electron_version: string; os_platform: string; os_arch: string; cpu_cores: number }
  | { kind: 'index_snapshot'; total_docs: number; total_vectors: number; collection_count: number }
  | { kind: 'hardware_snapshot'; cpu_cores: number; gpu_info?: string; gpu_vram?: string; gpu_device?: string };

let _enabled = false;
let _versionSnapshotEmitted = false;
let _hardwareSnapshotEmitted = false;
let _lastIndexSnapshotDate = '';

export function setTelemetryEnabled(v: boolean): void {
  _enabled = v;
  // Reset per-session flags when re-enabled so a fresh session gets fresh snapshots
  if (v) {
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
  if (!_enabled) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  const dest = telemetryPath();
  try {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(dest, line + '\n');
  } catch {
    // telemetry must never surface errors to the user
  }
}

/**
 * Wrap an async operation with timing. Emits a command_timing event on completion.
 * When telemetry is disabled, executes fn() with zero overhead.
 */
export async function timed<T>(
  meta: { command: string; transport: 'cli' | 'mcp'; mode?: string },
  fn: () => Promise<T>,
  getResultCount?: (result: T) => number,
): Promise<T> {
  if (!_enabled) return fn();
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

/** Emit a version_snapshot once per session. Fetches qmd version via execFile. */
export function emitVersionSnapshot(binary: string, pluginVersion: string): void {
  if (!_enabled || _versionSnapshotEmitted) return;
  _versionSnapshotEmitted = true;
  execFile(binary, ['--version'], { timeout: 5000, env: buildEnv() }, (err, stdout) => {
    record({
      kind: 'version_snapshot',
      plugin_version: pluginVersion,
      qmd_version: err ? 'unknown' : stdout.trim(),
      node_version: process.versions.node ?? 'unknown',
      electron_version: process.versions.electron ?? 'unknown',
      os_platform: os.platform(),
      os_arch: os.arch(),
      cpu_cores: os.cpus().length,
    });
  });
}

/** Emit an index_snapshot at most once per calendar day. */
export function maybeEmitIndexSnapshot(totalDocs: number, totalVectors: number, collectionCount: number): void {
  if (!_enabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (_lastIndexSnapshotDate === today) return;
  _lastIndexSnapshotDate = today;
  record({ kind: 'index_snapshot', total_docs: totalDocs, total_vectors: totalVectors, collection_count: collectionCount });
}

/** Emit a hardware_snapshot once per session (GPU info comes from qmd status output). */
export function emitHardwareSnapshot(gpuInfo?: string, gpuVram?: string, gpuDevice?: string): void {
  if (!_enabled || _hardwareSnapshotEmitted) return;
  _hardwareSnapshotEmitted = true;
  record({
    kind: 'hardware_snapshot',
    cpu_cores: os.cpus().length,
    ...(gpuInfo  ? { gpu_info:   gpuInfo  } : {}),
    ...(gpuVram  ? { gpu_vram:   gpuVram  } : {}),
    ...(gpuDevice ? { gpu_device: gpuDevice } : {}),
  });
}
