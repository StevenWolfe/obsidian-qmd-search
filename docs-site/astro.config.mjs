import { defineConfig } from 'astro/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, '../manifest.json'), 'utf8'));

export default defineConfig({
  site: 'https://stevenwolfe.github.io',
  base: '/obsidian-qmd-search',
  output: 'static',
  trailingSlash: 'ignore',
  vite: {
    define: {
      // Injected at build time from manifest.json — no hardcoded version strings needed.
      __PLUGIN_VERSION__: JSON.stringify(manifest.version),
    },
  },
});
