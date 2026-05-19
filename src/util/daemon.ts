const fs = require('fs') as typeof import('fs');
const net = require('net') as typeof import('net');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const { spawn } = require('child_process') as typeof import('child_process');

import type { ChildProcess } from 'child_process';
import { log } from './log';
import { buildEnv } from './env';

const PID_FILE = path.join(os.homedir(), '.cache', 'qmd', 'mcp.pid');

export function readPidFile(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function spawnDaemon(binary: string, port: number): ChildProcess {
  const child = spawn(binary, ['mcp', '--http', '--port', String(port)], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildEnv(),
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    log.debug('mcp stdout:', chunk.toString('utf8').trim());
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log.debug('mcp stderr:', chunk.toString('utf8').trim());
  });

  return child;
}

function tcpReachable(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const socket = net.connect(port, '127.0.0.1');
    const cleanup = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.on('connect', () => cleanup(true));
    socket.on('error', () => cleanup(false));
    signal.addEventListener('abort', () => cleanup(false), { once: true });
  });
}

export async function waitForEndpoint(
  port: number,
  signal: AbortSignal,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal.aborted) return;
    if (await tcpReachable(port, signal)) return;
    if (signal.aborted) return;
    await new Promise<void>((r) => {
      const t = setTimeout(r, intervalMs);
      signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
    });
  }

  if (!signal.aborted) {
    throw new Error(`qmd MCP daemon did not start within ${timeoutMs}ms on port ${port}`);
  }
}
