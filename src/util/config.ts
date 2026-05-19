const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const { execFile } = require('child_process') as typeof import('child_process');
import yaml from 'js-yaml';

interface IndexYml {
  collections?: Array<{ name?: string; [key: string]: unknown }> | Record<string, unknown>;
}

export function getConfigPath(): string {
  return path.join(os.homedir(), '.config', 'qmd', 'index.yml');
}

export function loadCollectionNames(): string[] {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const doc = yaml.load(raw) as IndexYml | null;
    if (!doc) return [];

    if (Array.isArray(doc.collections)) {
      return doc.collections
        .map((c) => (typeof c === 'object' && c !== null ? (c.name as string) : undefined))
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
    }

    if (doc.collections && typeof doc.collections === 'object') {
      return Object.keys(doc.collections);
    }

    return [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[obsidian-qmd-search] Could not parse index.yml:', err);
    }
    return [];
  }
}

/**
 * Try to enumerate named qmd indexes. Attempts two strategies in order:
 * 1. `qmd index list` CLI (one name per line, ignores errors)
 * 2. Filesystem scan of XDG data dir for *.db files
 * Returns [] if neither yields results.
 */
export function loadIndexNamesAsync(binary: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(binary, ['index', 'list'], { timeout: 5000, env }, (_err, stdout) => {
      if (!_err && stdout.trim()) {
        const names = stdout.split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('-'));
        if (names.length > 0) { resolve(names); return; }
      }

      // Fallback: scan XDG data dir for *.db files
      const dataDir = path.join(os.homedir(), '.local', 'share', 'qmd');
      try {
        const names = fs.readdirSync(dataDir)
          .filter((f: string) => f.endsWith('.db'))
          .map((f: string) => path.basename(f, '.db'));
        resolve(names);
      } catch {
        resolve([]);
      }
    });
  });
}
