// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process') as typeof import('child_process');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require('os') as typeof import('os');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path') as typeof import('path');

import { App, Menu, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type QmdSearchPlugin from './main';
import { type LogLevel, setLogLevel, log } from './util/log';
import { buildEnv, resolveQmdBinary } from './util/env';
import { loadCollectionNames } from './util/config';
import { SearchModal } from './ui/SearchModal';
import type { QmdStatus } from './client/types';

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
  recentQueries: string[];
  onboardingDone: boolean;
  autoReindex: boolean;
  reindexDebounceSeconds: number;
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
  recentQueries: [],
  onboardingDone: false,
  autoReindex: false,
  reindexDebounceSeconds: 30,
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
  if (current && !allValues.includes(current)) {
    const opt = document.createElement('option');
    opt.value = current; opt.text = current;
    sel.add(opt);
  }
  sel.value = current;
}

export class CollectionNameModal extends Modal {
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
  constructor(app: App, private readonly plugin: QmdSearchPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const wasAdvancedOpen =
      (containerEl.querySelector('.qmd-advanced-section') as HTMLDetailsElement | null)?.open ?? false;
    containerEl.empty();
    containerEl.addClass('qmd-settings');

    // ── Header ────────────────────────────────────────────────
    const header = containerEl.createDiv({ cls: 'qmd-settings-header' });
    header.createEl('h2', { text: 'QMD Search', cls: 'qmd-settings-title' });
    const headerMeta = header.createDiv({ cls: 'qmd-settings-meta' });
    headerMeta.createEl('span', {
      cls: 'qmd-version-pill',
      text: `plugin v${this.plugin.manifest.version}`,
    });

    // Header action buttons (will add Re-index and Search after status loads)
    const headerActions = header.createDiv({ cls: 'qmd-settings-header-actions' });

    // Binary status pill (async)
    const binaryPill = headerMeta.createEl('span', { cls: 'qmd-binary-pill qmd-binary-pill--checking', text: 'checking…' });
    if (this.plugin.resolvedBinaryPath !== 'qmd') {
      runVersion(this.plugin.resolvedBinaryPath).then((v) => {
        if (!binaryPill.isConnected) return;
        binaryPill.setText(`binary OK · ${v}`);
        binaryPill.removeClass('qmd-binary-pill--checking');
        binaryPill.addClass('qmd-binary-pill--ok');
      }).catch(() => {
        if (!binaryPill.isConnected) return;
        binaryPill.setText('binary error');
        binaryPill.removeClass('qmd-binary-pill--checking');
        binaryPill.addClass('qmd-binary-pill--err');
      });
    } else {
      binaryPill.setText('binary not found');
      binaryPill.removeClass('qmd-binary-pill--checking');
      binaryPill.addClass('qmd-binary-pill--err');
    }

    // ── Async content area ────────────────────────────────────
    const contentArea = containerEl.createDiv({ cls: 'qmd-settings-content' });
    contentArea.createEl('p', { cls: 'qmd-loading', text: 'Loading index status…' });

    // Fetch status and render appropriate layout
    this.plugin.client.status().then((status) => {
      if (!contentArea.isConnected) return;
      contentArea.empty();

      if (status.collections.length === 0) {
        this.renderFirstRun(contentArea, wasAdvancedOpen);
      } else {
        // Add Re-index and Search buttons to header
        const reindexBtn = headerActions.createEl('button', { cls: 'qmd-header-btn', text: 'Re-index ↺' });
        reindexBtn.addEventListener('click', async () => {
          reindexBtn.disabled = true;
          reindexBtn.textContent = 'Re-indexing…';
          await this.plugin.reindex();
          if (reindexBtn.isConnected) {
            reindexBtn.disabled = false;
            reindexBtn.textContent = 'Re-index ↺';
          }
          this.display();
        });
        const searchBtn = headerActions.createEl('button', { cls: 'qmd-header-btn mod-cta', text: 'Search… ⌘K' });
        searchBtn.addEventListener('click', () => {
          new SearchModal(this.app, this.plugin.client, this.plugin.settings, this.plugin).open();
        });

        this.renderHealthy(contentArea, status, wasAdvancedOpen);
      }
    }).catch((err: Error) => {
      log.error('settings status failed:', err.message);
      if (!contentArea.isConnected) return;
      contentArea.empty();
      this.renderFirstRun(contentArea, wasAdvancedOpen, err.message);
    });
  }

  private renderFirstRun(container: HTMLElement, wasAdvancedOpen: boolean, errorMsg?: string): void {
    // Empty state card
    const card = container.createDiv({ cls: 'qmd-empty-card' });
    card.createEl('div', { cls: 'qmd-empty-card-icon', text: '🗄' });
    const cardBody = card.createDiv({ cls: 'qmd-empty-card-body' });
    cardBody.createEl('strong', { text: 'Index your vault to start searching' });
    cardBody.createEl('p', {
      cls: 'qmd-muted',
      text: errorMsg
        ? `Error: ${errorMsg}`
        : 'QMD hasn\'t seen this vault yet. Indexing runs locally and takes about 30s per 1,000 notes.',
    });
    const indexBtn = card.createEl('button', { cls: 'mod-cta', text: 'Index this vault' });
    indexBtn.addEventListener('click', async () => {
      const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath ?? '';
      const vaultName = this.app.vault.getName();

      const name = await new Promise<string | null>((resolve) => {
        new CollectionNameModal(this.app, vaultName, resolve).open();
      });
      if (!name) return;

      indexBtn.disabled = true;
      indexBtn.textContent = 'Registering…';
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
        await this.plugin.embed();
        new Notice(`QMD: vault registered as "${name}" ✓`);
        this.display();
      } catch (err) {
        new Notice(`QMD: registration failed — ${(err as Error).message}`);
        if (indexBtn.isConnected) {
          indexBtn.disabled = false;
          indexBtn.textContent = 'Index this vault';
        }
      }
    });

    this.renderGeneralSettings(container);
    this.renderAdvancedSection(container, wasAdvancedOpen);
  }

  private renderHealthy(container: HTMLElement, status: QmdStatus, wasAdvancedOpen: boolean): void {
    // Status card
    const card = container.createDiv({ cls: 'qmd-health-card' });
    const cardHeader = card.createDiv({ cls: 'qmd-health-card-header' });
    const dot = cardHeader.createSpan({ cls: 'qmd-dot qmd-dot--ok' });
    void dot;
    cardHeader.createEl('strong', { text: 'Index healthy' });

    const cardActions = card.createDiv({ cls: 'qmd-health-card-actions' });
    const reindexCardBtn = cardActions.createEl('button', { cls: 'qmd-health-action-btn', text: '↻ Re-index' });
    reindexCardBtn.setAttribute('title', 'Run qmd update — refreshes the text index after adding or editing notes. Fast.');
    reindexCardBtn.addEventListener('click', () => { void this.plugin.reindex(); });
    const embedCardBtn = cardActions.createEl('button', { cls: 'qmd-health-action-btn', text: '⟳ Embed' });
    embedCardBtn.setAttribute('title', 'Run qmd embed — generates vector embeddings for semantic/hybrid search. Run after re-indexing.');
    embedCardBtn.addEventListener('click', () => { void this.plugin.embed(); });

    const totalDocs = status.totalDocs ?? status.collections.reduce((n, c) => n + c.docCount, 0);
    const totalVectors = status.totalVectors ?? 0;
    const lastIndexed = status.collections[0]?.lastIndexed;

    if (lastIndexed) {
      cardHeader.createEl('span', {
        cls: 'qmd-health-meta',
        text: `Last indexed ${lastIndexed}`,
      });
    }

    // Stats row
    const statsRow = card.createDiv({ cls: 'qmd-health-stats' });
    const statItems: [string, string][] = [
      ['Documents', totalDocs.toLocaleString()],
      ['Collections', String(status.collections.length)],
      ['Embeddings', totalVectors.toLocaleString()],
    ];
    if (status.indexSize) statItems.push(['Disk', status.indexSize]);
    for (const [label, value] of statItems) {
      const stat = statsRow.createDiv({ cls: 'qmd-health-stat' });
      stat.createEl('div', { cls: 'qmd-health-stat-label', text: label });
      stat.createEl('div', { cls: 'qmd-health-stat-value', text: value });
    }

    // ── Collections section ────────────────────────────────────
    const collSection = container.createDiv({ cls: 'qmd-settings-section' });
    const collHeader = collSection.createDiv({ cls: 'qmd-section-header' });
    collHeader.createEl('span', { cls: 'qmd-section-title', text: 'Collections' });
    const addBtn = collHeader.createEl('button', { cls: 'qmd-section-btn', text: '+ Add collection' });
    addBtn.addEventListener('click', async () => {
      const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath ?? '';
      const vaultName = this.app.vault.getName();
      const name = await new Promise<string | null>((resolve) => {
        new CollectionNameModal(this.app, vaultName, resolve).open();
      });
      if (!name) return;
      new Notice(`QMD: registering "${name}"…`);
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(
            this.plugin.resolvedBinaryPath,
            ['collection', 'add', vaultPath, '--name', name],
            { timeout: 30_000, env: buildEnv() },
            (err) => (err ? reject(err) : resolve()),
          );
        });
        new Notice(`QMD: "${name}" registered ✓`);
        this.display();
      } catch (err) {
        new Notice(`QMD: failed — ${(err as Error).message}`);
      }
    });

    const collList = collSection.createDiv({ cls: 'qmd-collection-list' });
    for (const col of status.collections) {
      const row = collList.createDiv({ cls: 'qmd-collection-row' });
      row.createEl('span', { cls: 'qmd-col-icon', text: '🗄' });
      row.createEl('span', { cls: 'qmd-col-name', text: col.name });
      row.createEl('span', { cls: 'qmd-col-docs qmd-muted', text: `${col.docCount.toLocaleString()} docs` });
      if (col.lastIndexed) {
        row.createEl('span', { cls: 'qmd-col-time qmd-muted', text: col.lastIndexed });
      }
      const menuBtn = row.createEl('button', { cls: 'qmd-col-menu', text: '⋯' });
      menuBtn.addEventListener('click', (e: MouseEvent) => {
        const menu = new Menu();
        menu.addItem((item) => {
          item.setTitle('Re-index').setIcon('refresh-cw').onClick(async () => {
            new Notice(`QMD: re-indexing "${col.name}"…`);
            await this.plugin.reindex();
            this.display();
          });
        });
        menu.addItem((item) => {
          item.setTitle('Generate embeddings').setIcon('cpu').onClick(async () => {
            new Notice(`QMD: generating embeddings for "${col.name}"…`);
            await this.plugin.embed();
            this.display();
          });
        });
        menu.addItem((item) => {
          item.setTitle('Remove').onClick(async () => {
            new Notice(`QMD: removing collection "${col.name}"…`);
            try {
              await new Promise<void>((resolve, reject) => {
                execFile(
                  this.plugin.resolvedBinaryPath,
                  ['collection', 'remove', col.name],
                  { timeout: 10_000, env: buildEnv() },
                  (err) => (err ? reject(err) : resolve()),
                );
              });
              new Notice(`QMD: removed "${col.name}" ✓`);
              this.display();
            } catch (err) {
              new Notice(`QMD: remove failed — ${(err as Error).message}`);
            }
          });
        });
        menu.showAtMouseEvent(e);
      });
    }

    this.renderGeneralSettings(container);
    this.renderAdvancedSection(container, wasAdvancedOpen);
  }

  private renderGeneralSettings(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'qmd-settings-section' });
    section.createEl('div', { cls: 'qmd-section-title', text: 'General' });

    // Default search mode
    new Setting(section)
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

    // Default collection
    const collectionNames = loadCollectionNames();
    let collectionSelectEl: HTMLSelectElement | undefined;
    new Setting(section)
      .setName('Default collection')
      .setDesc('Pre-selected collection in the search modal.')
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
    void (async () => {
      const names = loadCollectionNames();
      if (!collectionSelectEl?.isConnected || names.length === 0) return;
      populateSelect(
        collectionSelectEl,
        [{ value: '', label: 'All collections' }, ...names.map((n) => ({ value: n, label: n }))],
        this.plugin.settings.defaultCollection,
      );
    })();

    // Auto-reindex
    new Setting(section)
      .setName('Auto-reindex on save')
      .setDesc('Re-index collections automatically when a note is saved.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoReindex)
          .onChange(async (value) => {
            this.plugin.settings.autoReindex = value;
            await this.plugin.saveSettings(false);
          }),
      );

    const debounceValueEl = section.createEl('span', {
      text: `${this.plugin.settings.reindexDebounceSeconds}s`,
      cls: 'qmd-slider-value',
    });
    new Setting(section)
      .setName('Reindex delay')
      .setDesc('Seconds to wait after the last file change before triggering a reindex.')
      .setClass('qmd-setting-with-value')
      .addSlider((slider) =>
        slider
          .setLimits(5, 120, 5)
          .setValue(this.plugin.settings.reindexDebounceSeconds)
          .onChange(async (value) => {
            debounceValueEl.setText(`${value}s`);
            this.plugin.settings.reindexDebounceSeconds = value;
            await this.plugin.saveSettings(false);
          }),
      )
      .settingEl.append(debounceValueEl);

    // qmd binary path
    const versionEl = section.createEl('p', { cls: 'qmd-version-hint' });
    if (this.plugin.resolvedBinaryPath !== 'qmd' && this.plugin.settings.qmdBinaryPath === 'qmd') {
      versionEl.setText(`resolved → ${this.plugin.resolvedBinaryPath}`);
      versionEl.addClass('qmd-version-ok');
    }
    let binaryInputEl: HTMLInputElement;
    new Setting(section)
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
  }

  private renderAdvancedSection(container: HTMLElement, wasOpen: boolean): void {
    const advancedEl = container.createEl('details', { cls: 'qmd-advanced-section' });
    if (wasOpen) advancedEl.open = true;
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

    // Open config folder (safe — opens folder, not the file)
    new Setting(advancedEl)
      .setName('Open config folder')
      .setDesc('Open ~/.config/qmd/ in the system file manager.')
      .addButton((btn) => {
        btn.setButtonText('Open folder').onClick(async () => {
          const configDir = path.join(os.homedir(), '.config', 'qmd');
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { shell } = require('electron') as typeof import('electron');
          const target = fs.existsSync(configDir) ? configDir : null;
          if (!target) {
            new Notice('QMD: ~/.config/qmd/ not found — install qmd first.');
            return;
          }
          const err = await shell.openPath(target);
          if (err) new Notice(`QMD: failed to open folder — ${err}`);
        });
      });
  }
}
