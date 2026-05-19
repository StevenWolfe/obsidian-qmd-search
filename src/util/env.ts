const { execFile } = require('child_process') as typeof import('child_process');

import { log } from './log';
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');

// Cached result of initShellContext(). Populated once at plugin load.
let _shellEnv: NodeJS.ProcessEnv | null = null;

/**
 * Build a PATH-augmented environment for spawning qmd subprocesses.
 *
 * Uses the cached shell environment (from initShellContext) as the base when
 * available, so conda/virtualenv/pyenv/NVM variables are all present.
 * Falls back to Electron's process.env with common bin dirs appended.
 */
export function buildEnv(): NodeJS.ProcessEnv {
  const base = _shellEnv ?? process.env;
  const home = os.homedir();

  // Extra PATH entries to prepend when the shell env is unavailable or sparse
  const extra: string[] = [];
  if (base.NVM_BIN) extra.push(base.NVM_BIN);
  try {
    for (const v of fs.readdirSync(path.join(home, '.nvm', 'versions', 'node'))) {
      extra.push(path.join(home, '.nvm', 'versions', 'node', v, 'bin'));
    }
  } catch { /* no nvm */ }
  extra.push(
    '/opt/homebrew/bin', '/opt/homebrew/sbin',           // Apple Silicon Homebrew
    path.join(home, '.volta', 'bin'),                    // Volta
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin',
  );
  if (base.FNM_MULTISHELL_PATH) extra.push(base.FNM_MULTISHELL_PATH);

  const current = (base.PATH ?? '').split(':').filter(Boolean);
  const seen = new Set(current);
  const appended = extra.filter((p) => !seen.has(p));

  return { ...base, PATH: [...current, ...appended].join(':') };
}

/**
 * Spawn the user's login shell once to capture:
 *   - The full environment (conda, virtualenv, pyenv, NVM vars, etc.)
 *   - The resolved path to the qmd binary
 *
 * Calling this before buildClient() ensures qmd subprocesses receive the
 * same environment the user sees in their terminal, fixing issues like
 * missing readline, missing Python packages, or qmd not on PATH.
 *
 * Returns the resolved qmd binary path (or the hint unchanged on failure).
 */
export function initShellContext(hint = 'qmd'): Promise<string> {
  // User provided an explicit path — skip shell lookup but still warm env
  const needsBinaryResolution = hint === 'qmd';

  const shell = process.env.SHELL || '/bin/zsh';
  const cmd = needsBinaryResolution
    ? 'command -v qmd 2>/dev/null || which qmd 2>/dev/null; echo "===ENV==="; env'
    : 'echo "===ENV==="; env';

  log.debug('initShellContext: shell=%s hint=%s', shell, hint);
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-l', '-c', cmd],
      { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
      (_err, stdout) => {
        if (_err) log.warn('initShellContext shell error:', _err.message);
        const marker = stdout.indexOf('===ENV===');
        let resolvedBinary = hint;

        if (marker !== -1) {
          // Parse env section
          const envSection = stdout.slice(marker + '===ENV==='.length + 1);
          const env: NodeJS.ProcessEnv = {};
          for (const line of envSection.split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
          }
          const envCount = Object.keys(env).length;
          if (envCount > 5) {
            _shellEnv = env;
            log.debug('initShellContext: captured %d env vars, PATH=%s', envCount, env.PATH?.slice(0, 120));
          } else {
            log.warn('initShellContext: env capture returned only %d vars — shell may have errored', envCount);
          }

          // Parse binary path from section before the marker
          if (needsBinaryResolution) {
            const before = stdout.slice(0, marker).trim();
            const found = before.split('\n').find((l) => l.startsWith('/'));
            if (found) resolvedBinary = found.trim();
            log.debug('initShellContext: shell resolved binary to:', resolvedBinary);
          }
        } else {
          log.warn('initShellContext: ===ENV=== marker not found in shell output');
        }

        // Fallback filesystem scan using the now-populated buildEnv() PATH
        if (resolvedBinary === 'qmd') {
          const env = buildEnv();
          for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
            const candidate = path.join(dir, 'qmd');
            try {
              fs.accessSync(candidate, fs.constants.X_OK);
              resolvedBinary = candidate;
              log.debug('initShellContext: filesystem scan found binary at:', resolvedBinary);
              break;
            } catch { /* keep looking */ }
          }
        }

        if (resolvedBinary === 'qmd') {
          log.warn('initShellContext: qmd binary not found — will rely on PATH at exec time');
        } else {
          log.debug('initShellContext: resolved binary:', resolvedBinary);
        }
        resolve(resolvedBinary);
      },
    );
  });
}

// Keep old name as an alias so settings.ts "Auto-detect" still compiles.
export const resolveQmdBinary = initShellContext;
