// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process') as typeof import('child_process');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require('os') as typeof import('os');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path') as typeof import('path');

import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type QmdSearchPlugin from './main';
import { StatusModal } from './ui/StatusModal';
import { type LogLevel, setLogLevel, log } from './util/log';
import { buildEnv, resolveQmdBinary } from './util/env';
import { loadCollectionNames } from './util/config';

export interface QmdSearchSettings {
  qmdBinaryPath: string;
  indexName: string;
  transportMode: 'cli' | 'mcp-http';
  mcpPort: number;
  defaultCollection: string;
  defaultSearchMode: 'keyword' | 'semantic' | 'hybrid';
  noRerank: boolean;
  candidateLimit: number;
  minScore: number;
  logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: QmdSearchSettings = {
  qmdBinaryPath: 'qmd',
  indexName: '',
  transportMode: 'cli',
  mcpPort: 8181,
  defaultCollection: '',
  defaultSearchMode: 'hybrid',
  noRerank: false,
  candidateLimit: 0,
  minScore: 0,
  logLevel: 'error',
};

function runVersion(binary: string): Promise<string> {
  if (!binary.trim()) return Promise.reject(new Error('empty path'));
  if ((binary.includes('/') || binary.includes('\\')) && !fs.existsSync(binary)) {
    return Promise.reject(new Error('file not found'));
  }
  return new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { timeout: 5000, env: buildEnv() }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/** Populate a <select> element with options, restoring the current value. */
function populateSelect(sel: HTMLSelectElement, options: { value: string; label: string }[], current: string): void {
  const allValues = options.map((o) => o.value);
  while (sel.options.length) sel.remove(0);
  for (const { value, label } of options) {
    const opt = document.createElement('option');
    opt.value = value; opt.text = label;
    sel.add(opt);
  }
  // If saved value isn't in the list, add it so it doesn't disappear
  if (current && !allValues.includes(current)) {
    const opt = document.createElement('option');
    opt.value = current; opt.text = current;
    sel.add(opt);
  }
  sel.value = current;
}

class CollectionNameModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly defaultValue: string,
    private readonly onSubmit: (name: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('qmd-collection-name-modal');
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Register vault as collection' });
    const input = contentEl.createEl('input', { type: 'text', value: this.defaultValue, placeholder: 'Collection name' });
    input.classList.add('qmd-collection-name-input');

    const btnRow = contentEl.createDiv({ cls: 'qmd-collection-name-buttons' });
    const registerBtn = btnRow.createEl('button', { text: 'Register', cls: 'mod-cta' });
    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });

    const submit = () => {
      if (this.resolved) return;
      const name = input.value.trim();
      if (!name) return;
      this.resolved = true;
      this.close();
      this.onSubmit(name);
    };
    const cancel = () => {
      if (this.resolved) return;
      this.resolved = true;
      this.close();
      this.onSubmit(null);
    };

    registerBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') cancel();
    });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  onClose(): void {
    if (!this.resolved) { this.resolved = true; this.onSubmit(null); }
    this.contentEl.empty();
  }
}

export class QmdSettingTab extends PluginSettingTab {
  private statusEl: HTMLElement | null = null;

  constructor(app: App, private readonly plugin: QmdSearchPlugin) {
    super(app, plugin);
  }

  renderStatus(): void {
    const el = this.statusEl;
    if (!el?.isConnected) return;

    if (this.plugin.resolvedBinaryPath === 'qmd') {
      el.empty();
      el.createEl('p', { text: 'qmd not found — set binary path above.', cls: 'qmd-muted' });
      return;
    }

    el.empty();
    el.createEl('p', { text: 'Checking…', cls: 'qmd-muted' });

    this.plugin.client.status().then((s) => {
      if (!el.isConnected) return;
      el.empty();
      const health = el.createDiv({ cls: 'qmd-status-health' });
      health.createEl('span', {
        text: s.healthy ? '✓ Healthy' : '✗ Unhealthy',
        cls: s.healthy ? 'qmd-status-ok' : 'qmd-status-err',
      });
      if (s.message) health.createEl('span', { text: ` — ${s.message}`, cls: 'qmd-status-message' });

      if (s.indexPath || s.indexSize) {
        const meta = el.createDiv({ cls: 'qmd-status-meta' });
        if (s.indexPath) meta.createEl('span', { text: s.indexPath.split('/').pop() ?? s.indexPath });
        if (s.indexSize) meta.createEl('span', { text: ` (${s.indexSize})`, cls: 'qmd-muted' });
      }
      if (s.totalDocs !== undefined || s.totalVectors !== undefined) {
        const parts: string[] = [];
        if (s.totalDocs !== undefined) parts.push(`${s.totalDocs} docs`);
        if (s.totalVectors !== undefined) parts.push(`${s.totalVectors} vectors`);
        el.createEl('p', { text: parts.join(' · '), cls: 'qmd-status-docs-line qmd-muted' });
      }

      if (s.collections.length === 0) {
        el.createEl('p', { text: 'No collections registered.', cls: 'qmd-muted' });
        return;
      }
      const table = el.createEl('table', { cls: 'qmd-status-table' });
      const head = table.createEl('thead').createEl('tr');
      head.createEl('th', { text: 'Collection' });
      head.createEl('th', { text: 'Docs' });
      head.createEl('th', { text: 'Last indexed' });
      const tbody = table.createEl('tbody');
      for (const col of s.collections) {
        const row = tbody.createEl('tr');
        row.createEl('td', { text: col.name });
        row.createEl('td', { text: String(col.docCount) });
        row.createEl('td', { text: col.lastIndexed ?? '—' });
      }
    }).catch((err: Error) => {
      log.error('status failed:', err.message);
      if (!el.isConnected) return;
      el.empty();
      el.createEl('p', { text: `Status error: ${err.message}`, cls: 'qmd-error' });
    });
  }

  display(): void {
    const { containerEl } = this;
    const wasAdvancedOpen =
      (containerEl.querySelector('.qmd-advanced-section') as HTMLDetailsElement | null)?.open ?? false;
    containerEl.empty();

    containerEl.createEl('p', {
      text: `plugin v${this.plugin.manifest.version}`,
      cls: 'qmd-plugin-version',
    });

    // ── Binary path ──────────────────────────────────────────
    const versionEl = containerEl.createEl('p', { cls: 'qmd-version-hint' });
    if (this.plugin.resolvedBinaryPath !== 'qmd' && this.plugin.settings.qmdBinaryPath === 'qmd') {
      versionEl.setText(`resolved → ${this.plugin.resolvedBinaryPath}`);
      versionEl.addClass('qmd-version-ok');
    }
    let binaryInputEl: HTMLInputElement;
    new Setting(containerEl)
      .setName('qmd binary path')
      .setDesc('Path to the qmd executable. Leave as "qmd" to auto-detect.')
      .addText((text) => {
        binaryInputEl = text.inputEl;
        text
          .setPlaceholder('qmd')
          .setValue(this.plugin.settings.qmdBinaryPath)
          .onChange((value) => { this.plugin.settings.qmdBinaryPath = value; });
        text.inputEl.addEventListener('blur', async () => {
          await this.plugin.saveSettings();
          try {
            const version = await runVersion(this.plugin.resolvedBinaryPath);
            if (!versionEl.isConnected) return;
            versionEl.setText(`✓ ${version}`);
            versionEl.removeClass('qmd-version-error');
            versionEl.addClass('qmd-version-ok');
          } catch {
            if (!versionEl.isConnected) return;
            versionEl.setText('✗ qmd not found or failed');
            versionEl.removeClass('qmd-version-ok');
            versionEl.addClass('qmd-version-error');
          }
          this.renderStatus();
        });
      })
      .addButton((btn) => {
        btn.setButtonText('Auto-detect').onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Detecting…');
          try {
            const resolved = await resolveQmdBinary('qmd');
            if (!versionEl.isConnected) return;
            if (resolved !== 'qmd') {
              binaryInputEl.value = resolved;
              this.plugin.settings.qmdBinaryPath = resolved;
              await this.plugin.saveSettings();
              try {
                const version = await runVersion(resolved);
                versionEl.setText(`✓ ${version}`);
                versionEl.removeClass('qmd-version-error');
                versionEl.addClass('qmd-version-ok');
              } catch {
                versionEl.setText(`Found at ${resolved} but --version failed`);
                versionEl.addClass('qmd-version-ok');
              }
              this.renderStatus();
            } else {
              versionEl.setText('✗ Could not find qmd — set path manually');
              versionEl.removeClass('qmd-version-ok');
              versionEl.addClass('qmd-version-error');
            }
          } finally {
            if (btn.buttonEl.isConnected) {
              btn.setDisabled(false);
              btn.setButtonText('Auto-detect');
            }
          }
        });
      });

    // ── Default collection (dropdown) ────────────────────────
    const collectionNames = loadCollectionNames();
    let collectionSelectEl: HTMLSelectElement | undefined;
    new Setting(containerEl)
      .setName('Default collection')
      .setDesc('Pre-selected collection in the search modal. "All" searches every collection.')
      .addDropdown((dd) => {
        collectionSelectEl = dd.selectEl;
        dd.addOption('', 'All collections');
        for (const name of collectionNames) dd.addOption(name, name);
        if (this.plugin.settings.defaultCollection && !collectionNames.includes(this.plugin.settings.defaultCollection)) {
          dd.addOption(this.plugin.settings.defaultCollection, this.plugin.settings.defaultCollection);
        }
        dd.setValue(this.plugin.settings.defaultCollection);
        dd.onChange(async (value) => {
          this.plugin.settings.defaultCollection = value;
          await this.plugin.saveSettings(false);
        });
      });
    // Keep the collection list fresh from config
    void (async () => {
      const names = loadCollectionNames();
      if (!collectionSelectEl?.isConnected || names.length === 0) return;
      populateSelect(
        collectionSelectEl,
        [{ value: '', label: 'All collections' }, ...names.map((n) => ({ value: n, label: n }))],
        this.plugin.settings.defaultCollection,
      );
    })();

    // ── Default search mode ──────────────────────────────────
    new Setting(containerEl)
      .setName('Default search mode')
      .addDropdown((dd) => {
        dd.addOption('keyword', 'Keyword')
          .addOption('semantic', 'Semantic')
          .addOption('hybrid', 'Hybrid (default)')
          .setValue(this.plugin.settings.defaultSearchMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultSearchMode = value as 'keyword' | 'semantic' | 'hybrid';
            await this.plugin.saveSettings(false);
          });
      });

    // ── Index management ─────────────────────────────────────
    new Setting(containerEl).setName('Index').setHeading();
    this.statusEl = containerEl.createDiv({ cls: 'qmd-status-inline' });
    this.renderStatus();

    const actionRow = containerEl.createDiv({ cls: 'qmd-action-row' });

    const reindexBtn = actionRow.createEl('button', { text: 'Re-index', cls: 'mod-cta' });
    reindexBtn.addEventListener('click', async () => {
      reindexBtn.disabled = true;
      reindexBtn.textContent = 'Re-indexing…';
      await this.plugin.reindex();
      if (reindexBtn.isConnected) {
        reindexBtn.disabled = false;
        reindexBtn.textContent = 'Re-index';
      }
      this.renderStatus();
    });

    const embedBtn = actionRow.createEl('button', { text: 'Embed' });
    embedBtn.addEventListener('click', async () => {
      embedBtn.disabled = true;
      embedBtn.textContent = 'Embedding…';
      await this.plugin.embed();
      if (embedBtn.isConnected) {
        embedBtn.disabled = false;
        embedBtn.textContent = 'Embed';
      }
      this.renderStatus();
    });

    const refreshBtn = actionRow.createEl('button', { text: 'Refresh' });
    refreshBtn.addEventListener('click', () => {
      this.renderStatus();
      this.plugin.refreshStatusBar();
    });

    const statusBtn = actionRow.createEl('button', { text: 'Full status' });
    statusBtn.addEventListener('click', () => new StatusModal(this.app, this.plugin).open());

    // ── Register vault as collection ─────────────────────────
    new Setting(containerEl)
      .setName('Register vault as collection')
      .setDesc('Index this vault with qmd so it appears in search.')
      .addButton((btn) => {
        btn.setButtonText('Register…').onClick(async () => {
          const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath ?? '';
          const vaultName = this.app.vault.getName();

          const name = await new Promise<string | null>((resolve) => {
            new CollectionNameModal(this.app, vaultName, resolve).open();
          });
          if (!name) return;

          btn.setDisabled(true);
          new Notice(`QMD: registering collection "${name}"…`);
          try {
            await new Promise<void>((resolve, reject) => {
              execFile(
                this.plugin.resolvedBinaryPath,
                ['collection', 'add', vaultPath, '--name', name],
                { timeout: 30_000, env: buildEnv() },
                (err) => (err ? reject(err) : resolve()),
              );
            });

            new Notice(`QMD: generating embeddings for "${name}"…`);
            await new Promise<void>((resolve, reject) => {
              execFile(
                this.plugin.resolvedBinaryPath,
                ['embed'],
                { timeout: 600_000, env: buildEnv() },
                (err) => (err ? reject(err) : resolve()),
              );
            });

            new Notice(`QMD: vault registered as "${name}" ✓`);
            this.renderStatus();
          } catch (err) {
            new Notice(`QMD: registration failed — ${(err as Error).message}`);
          } finally {
            if (btn.buttonEl.isConnected) btn.setDisabled(false);
          }
        });
      });

    // ── Open index config ────────────────────────────────────
    new Setting(containerEl)
      .setName('Open index config')
      .setDesc('Open ~/.config/qmd/index.yml in the system default app.')
      .addButton((btn) => {
        btn.setButtonText('Open config').onClick(async () => {
          const configPath = path.join(os.homedir(), '.config', 'qmd', 'index.yml');
          const configDir = path.dirname(configPath);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { shell } = require('electron') as typeof import('electron');
          const target = fs.existsSync(configPath) ? configPath
            : fs.existsSync(configDir) ? configDir
            : null;
          if (!target) {
            new Notice('QMD: ~/.config/qmd/ not found — install qmd first.');
            return;
          }
          const err = await shell.openPath(target);
          if (err) new Notice(`QMD: failed to open config — ${err}`);
        });
      });

    // ── Advanced (collapsible) ───────────────────────────────
    const advancedEl = containerEl.createEl('details', { cls: 'qmd-advanced-section' });
    if (wasAdvancedOpen) advancedEl.open = true;
    advancedEl.createEl('summary', { text: 'Advanced', cls: 'qmd-advanced-summary' });

    new Setting(advancedEl)
      .setName('Index name')
      .setDesc('Named index to use (--index flag). Leave blank for the qmd default ("index").')
      .addText((text) => {
        text
          .setPlaceholder('index')
          .setValue(this.plugin.settings.indexName)
          .onChange((value) => { this.plugin.settings.indexName = value.trim(); });
        text.inputEl.addEventListener('blur', async () => {
          await this.plugin.saveSettings();
          this.renderStatus();
        });
      });

    new Setting(advancedEl)
      .setName('Transport mode')
      .setDesc('CLI spawns qmd per-query; MCP-HTTP connects to a persistent daemon.')
      .addDropdown((dd) => {
        dd.addOption('cli', 'CLI (default)')
          .addOption('mcp-http', 'MCP HTTP daemon')
          .setValue(this.plugin.settings.transportMode)
          .onChange(async (value) => {
            this.plugin.settings.transportMode = value as 'cli' | 'mcp-http';
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.transportMode === 'mcp-http') {
      new Setting(advancedEl)
        .setName('MCP daemon port')
        .setDesc('Port the qmd MCP HTTP daemon listens on.')
        .addText((text) =>
          text
            .setPlaceholder('8181')
            .setValue(String(this.plugin.settings.mcpPort))
            .onChange(async (value) => {
              const port = parseInt(value, 10);
              if (!isNaN(port)) {
                this.plugin.settings.mcpPort = port;
                await this.plugin.saveSettings();
              }
            }),
        );
    }

    new Setting(advancedEl)
      .setName('Skip LLM reranking')
      .setDesc('Pass --no-rerank to qmd. Faster responses; BM25+vector fusion only.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.noRerank)
          .onChange(async (value) => {
            this.plugin.settings.noRerank = value;
            await this.plugin.saveSettings(false);
          }),
      );

    new Setting(advancedEl)
      .setName('Reranker candidate limit')
      .setDesc('Max candidates passed to the LLM reranker (-C flag). 0 = qmd default (~40).')
      .addText((text) =>
        text
          .setPlaceholder('0')
          .setValue(this.plugin.settings.candidateLimit > 0 ? String(this.plugin.settings.candidateLimit) : '')
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.candidateLimit = isNaN(n) || n < 0 ? 0 : n;
            await this.plugin.saveSettings(false);
          }),
      );

    new Setting(advancedEl)
      .setName('Minimum score')
      .setDesc('Filter results below this similarity score (--min-score). 0 = disabled.')
      .addText((text) =>
        text
          .setPlaceholder('0')
          .setValue(this.plugin.settings.minScore > 0 ? String(this.plugin.settings.minScore) : '')
          .onChange(async (value) => {
            const n = parseFloat(value);
            this.plugin.settings.minScore = isNaN(n) || n < 0 ? 0 : n;
            await this.plugin.saveSettings(false);
          }),
      );

    new Setting(advancedEl)
      .setName('Log level')
      .setDesc('Controls what qmd plugin output appears in the console.')
      .addDropdown((dd) =>
        dd
          .addOption('off',   'Off')
          .addOption('error', 'Errors only (default)')
          .addOption('warn',  'Warnings + errors')
          .addOption('debug', 'Debug (verbose)')
          .setValue(this.plugin.settings.logLevel)
          .onChange(async (value) => {
            this.plugin.settings.logLevel = value as LogLevel;
            setLogLevel(value as LogLevel);
            await this.plugin.saveSettings(false);
          }),
      );
  }
}
