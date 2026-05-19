import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const vaultPath = process.env.VAULT_PATH;
if (!vaultPath) {
  console.error('Error: VAULT_PATH environment variable is not set.');
  console.error('Usage: VAULT_PATH=/path/to/your/vault npm run deploy');
  process.exit(1);
}

if (!existsSync('main.js')) {
  console.error('Error: main.js not found. Run `npm run build` first.');
  process.exit(1);
}

const dest = join(vaultPath, '.obsidian', 'plugins', 'obsidian-qmd-search');
mkdirSync(dest, { recursive: true });

for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  copyFileSync(file, join(dest, file));
  console.log(`  copied ${file} → ${dest}/`);
}

console.log('Deploy complete. Reload Obsidian or toggle the plugin to pick up changes.');
