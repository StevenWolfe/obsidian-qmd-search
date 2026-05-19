const { execFile } = require('child_process') as typeof import('child_process');
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');

import { App, Menu, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type QmdSearchPlugin from './main';
import { type LogLevel, setLogLevel, log } from './util/log';
import { buildEnv } from './util/env';
import { loadCollectionNames } from './util/config';
import type { QmdStatus, IndexHealth } from './client/types';
import { computeIndexHealth } from './client/types';
import { timeAgo } from './util/time';

export interface QmdSearchSettings {
  qmdBinaryPath: string;
  indexName: string;
  transportMode: 'cli' | 'mcp-http';
  mcpPort: number;
  defaultCollection: string;
  defaultSearchMode: 'keyword' | 'semantic' | 'hybrid';
  noRerank: boolean;
  candidateLimit?: number;
  minScore?: number;
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
  defaultSearchMode: 'keyword',
  noRerank: false,
  candidateLimit: undefined,
  minScore: undefined,
  logLevel: 'error',
  recentQueries: [],
  onboardingDone: false,
  autoReindex: false,
  reindexDebounceSeconds: 90,
};

function runVersion(binary: string): Promise<string> {
  if (!binary.trim()) return Promise.reject(new Error('empty path'));
  if ((binary.includes('/') || binary.includes('\\')) && !fs.existsSync(binary)) {
    return Promise.reject(new Error('file not found'));
  }
  return new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { timeout: 5000, env: buildEnv() }, (err, stdout) => {
      if (err) reject(new Error(err.message));
      else resolve(stdout.trim());
    });
  });
}

/** Populate a <select> element with options, restoring the current value. */
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
  private tickTimer: number | null = null;

  constructor(app: App, private readonly plugin: QmdSearchPlugin) {
    super(app, plugin);
  }

  override hide(): void {
    if (this.tickTimer !== null) { window.clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  display(): void {
    if (this.tickTimer !== null) { window.clearInterval(this.tickTimer); this.tickTimer = null; }
    const { containerEl } = this;
    const wasAdvancedOpen =
      containerEl.querySelector<HTMLDetailsElement>('.qmd-advanced-section')?.open ?? false;
    containerEl.empty();
    containerEl.addClass('qmd-settings');

    // ── Header ────────────────────────────────────────────────
    const header = containerEl.createDiv({ cls: 'qmd-settings-header' });
    header.createEl('h2', { text: 'QMD Search', cls: 'qmd-settings-title' });
    const headerMeta = header.createDiv({ cls: 'qmd-settings-meta' });
    const docsLink = headerMeta.createEl('a', { cls: 'qmd-docs-link', text: 'Docs ↗' });
    docsLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.open('https://github.com/StevenWolfe/obsidian-qmd-search#readme');
    });
    // Plain muted version text — no colored pill (#15)
    headerMeta.createEl('span', {
      cls: 'qmd-version-meta',
      text: `plugin v${this.plugin.manifest.version}`,
    });

    // Binary status pill (async) — shows qmd version, moves SHA to Advanced (#7)
    const binaryPill = headerMeta.createEl('span', { cls: 'qmd-binary-pill qmd-binary-pill--checking', text: 'checking…' });
    if (this.plugin.resolvedBinaryPath !== 'qmd') {
      runVersion(this.plugin.resolvedBinaryPath).then((v) => {
        if (!binaryPill.isConnected) return;
        // Strip build hash from header; version only (#7)
        const versionOnly = v.replace(/\s*\([0-9a-f]{6,}\)\s*$/, '').trim();
        binaryPill.setText(`binary OK · ${versionOnly}`);
        binaryPill.removeClass('qmd-binary-pill--checking');
        binaryPill.addClass('qmd-binary-pill--ok');
        // Store full version for Advanced > About
        binaryPill.dataset.fullVersion = v;
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
    this.loadContent(contentArea, wasAdvancedOpen);
  }

  /** Refresh only the status content — header and form fields are not touched. */
  private refreshStatusArea(): void {
    if (this.tickTimer !== null) { window.clearInterval(this.tickTimer); this.tickTimer = null; }
    const contentArea = this.containerEl.querySelector<HTMLElement>('.qmd-settings-content');
    if (!contentArea) { this.display(); return; }
    const wasAdvancedOpen =
      contentArea.querySelector<HTMLDetailsElement>('.qmd-advanced-section')?.open ?? false;
    contentArea.empty();
    this.loadContent(contentArea, wasAdvancedOpen);
  }

  private loadContent(contentArea: HTMLElement, wasAdvancedOpen: boolean): void {
    contentArea.createEl('p', { cls: 'qmd-loading', text: 'Loading index status…' });
    this.plugin.client.status().then((status) => {
      if (!contentArea.isConnected) return;
      contentArea.empty();
      if (status.collections.length === 0) {
        this.renderFirstRun(contentArea, wasAdvancedOpen);
      } else {
        const totalDocs = status.totalDocs ?? status.collections.reduce((n, c) => n + c.docCount, 0);
        const totalVectors = status.totalVectors ?? 0;
        const health = computeIndexHealth(totalDocs, totalVectors);
        this.renderHealthy(contentArea, status, health, wasAdvancedOpen);
      }
      this.startTimeTick();
    }).catch((err: Error) => {
      log.error('settings status failed:', err.message);
      if (!contentArea.isConnected) return;
      contentArea.empty();
      this.renderFirstRun(contentArea, wasAdvancedOpen, err.message);
    });
  }

  /** Tick every 30 s — updates [data-last-indexed] spans in-place without a full redraw. */
  private startTimeTick(): void {
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = window.setInterval(() => {
      if (!this.containerEl.isConnected) {
        window.clearInterval(this.tickTimer!);
        this.tickTimer = null;
        return;
      }
      this.containerEl.querySelectorAll<HTMLElement>('[data-last-indexed]').forEach((el) => {
        el.setText(timeAgo(el.dataset.lastIndexed ?? ''));
      });
    }, 30_000);
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
            (err) => (err ? reject(new Error(err.message)) : resolve()),
          );
        });
        new Notice(`QMD: generating embeddings for "${name}"…`);
        await this.plugin.embed();
        new Notice(`QMD: vault registered as "${name}" ✓`);
        this.refreshStatusArea();
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

  private renderHealthy(container: HTMLElement, status: QmdStatus, health: IndexHealth, wasAdvancedOpen: boolean): void {
    const totalDocs = status.totalDocs ?? status.collections.reduce((n, c) => n + c.docCount, 0);
    const totalVectors = status.totalVectors ?? 0;
    const lastIndexed = status.collections[0]?.lastIndexed;

    const isPartial = health.kind === 'partial' || health.kind === 'stale';

    // Status card
    const card = container.createDiv({ cls: `qmd-health-card${isPartial ? ' qmd-health-card--warn' : ''}` });
    const cardHeader = card.createDiv({ cls: 'qmd-health-card-header' });
    const dot = cardHeader.createSpan({ cls: `qmd-dot ${isPartial ? 'qmd-dot--warn' : 'qmd-dot--ok'}` });
    void dot;

    if (isPartial) {
      cardHeader.createEl('strong', { text: 'Index partial — embeddings missing' });
      card.createEl('p', {
        cls: 'qmd-health-warn-sub',
        text: 'Hybrid & semantic modes will fall back to keyword until you run this.',
      });
    } else {
      cardHeader.createEl('strong', { text: 'Index healthy' });
      if (lastIndexed) {
        const timeEl = cardHeader.createEl('span', { cls: 'qmd-health-meta' });
        timeEl.dataset.lastIndexed = lastIndexed;
        timeEl.setText(`Last indexed ${timeAgo(lastIndexed)}`);
      }
    }

    // CTA: partial → "Generate embeddings"; healthy → "Re-index" (#5)
    const cardActions = card.createDiv({ cls: 'qmd-health-card-actions' });
    if (isPartial) {
      const embedCta = cardActions.createEl('button', { cls: 'qmd-health-action-btn mod-cta', text: '✨ Generate embeddings' });
      embedCta.addEventListener('click', async () => {
        embedCta.disabled = true;
        embedCta.textContent = '⏳ Embedding…';
        await this.plugin.embed();
        if (embedCta.isConnected) this.refreshStatusArea();
      });
      const reindexBtn = cardActions.createEl('button', { cls: 'qmd-health-action-btn', text: '↻ Re-index' });
      reindexBtn.setAttribute('title', 'Refresh the text index (fast). Run before generating embeddings.');
      reindexBtn.addEventListener('click', async () => {
        reindexBtn.disabled = true;
        reindexBtn.textContent = '⏳ Indexing…';
        await this.plugin.reindex();
        if (reindexBtn.isConnected) this.refreshStatusArea();
      });
    } else {
      const reindexCardBtn = cardActions.createEl('button', { cls: 'qmd-health-action-btn', text: '↻ Re-index' });
      reindexCardBtn.setAttribute('title', 'Run qmd update — refreshes the text index after adding or editing notes. Fast.');
      reindexCardBtn.addEventListener('click', async () => {
        reindexCardBtn.disabled = true;
        reindexCardBtn.textContent = '⏳ Indexing…';
        await this.plugin.reindex();
        if (reindexCardBtn.isConnected) this.refreshStatusArea();
      });
      const embedCardBtn = cardActions.createEl('button', { cls: 'qmd-health-action-btn', text: '✨ Generate embeddings' });
      embedCardBtn.setAttribute('title', 'Run qmd embed — generates vector embeddings for semantic/hybrid search.');
      embedCardBtn.addEventListener('click', async () => {
        embedCardBtn.disabled = true;
        embedCardBtn.textContent = '⏳ Embedding…';
        await this.plugin.embed();
        if (embedCardBtn.isConnected) this.refreshStatusArea();
      });
    }

    // Stats row
    const statsRow = card.createDiv({ cls: 'qmd-health-stats' });
    const embeddingsStr = isPartial
      ? `0 / ${totalDocs.toLocaleString()}`
      : `${totalVectors.toLocaleString()} / ${totalDocs.toLocaleString()}`;
    const statItems: Array<[string, string, boolean?]> = [
      ['Documents', totalDocs.toLocaleString()],
      ['Collections', String(status.collections.length)],
      ['Embeddings', embeddingsStr, isPartial],
    ];
    if (status.indexSize) statItems.push(['Disk', status.indexSize]);
    for (const [label, value, warn] of statItems) {
      const stat = statsRow.createDiv({ cls: 'qmd-health-stat' });
      stat.createEl('div', { cls: 'qmd-health-stat-label', text: label });
      stat.createEl('div', { cls: `qmd-health-stat-value${warn ? ' qmd-health-stat-value--warn' : ''}`, text: value });
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
            (err) => (err ? reject(new Error(err.message)) : resolve()),
          );
        });
        new Notice(`QMD: "${name}" registered ✓`);
        this.refreshStatusArea();
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
        const colTimeEl = row.createEl('span', { cls: 'qmd-col-time qmd-muted' });
        colTimeEl.dataset.lastIndexed = col.lastIndexed;
        colTimeEl.setText(timeAgo(col.lastIndexed));
      }
      const menuBtn = row.createEl('button', { cls: 'qmd-col-menu', text: '⋯' });
      menuBtn.addEventListener('click', (e: MouseEvent) => {
        const menu = new Menu();
        menu.addItem((item) => {
          item.setTitle('Re-index').setIcon('refresh-cw').onClick(async () => {
            new Notice(`QMD: re-indexing "${col.name}"…`);
            await this.plugin.reindex();
            this.refreshStatusArea();
          });
        });
        menu.addItem((item) => {
          item.setTitle('Generate embeddings').setIcon('cpu').onClick(async () => {
            new Notice(`QMD: generating embeddings for "${col.name}"…`);
            await this.plugin.embed();
            this.refreshStatusArea();
          });
        });
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle('Remove').setIcon('trash').onClick(async () => {
            new Notice(`QMD: removing collection "${col.name}"…`);
            try {
              await new Promise<void>((resolve, reject) => {
                execFile(
                  this.plugin.resolvedBinaryPath,
                  ['collection', 'remove', col.name],
                  { timeout: 10_000, env: buildEnv() },
                  (err) => (err ? reject(new Error(err.message)) : resolve()),
                );
              });
              new Notice(`QMD: removed "${col.name}" ✓`);
              this.refreshStatusArea();
            } catch (err) {
              new Notice(`QMD: remove failed — ${(err as Error).message}`);
            }
          });
          // Apply destructive styling — `dom` exists at runtime but isn't in the public type
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (item as any).dom?.addClass('qmd-menu-item--destructive');
        });
        menu.showAtMouseEvent(e);
      });
    }

    this.renderGeneralSettings(container, status.collections.map((c) => c.name), health);
    this.renderAdvancedSection(container, wasAdvancedOpen);
  }

  private renderGeneralSettings(container: HTMLElement, liveCollectionNames?: string[], health?: IndexHealth): void {
    const section = container.createDiv({ cls: 'qmd-settings-section' });
    section.createEl('div', { cls: 'qmd-section-title', text: 'General' });

    const isPartial = health?.kind === 'partial' || health?.kind === 'stale';

    // Default search mode — warn if partial and hybrid/semantic selected
    new Setting(section)
      .setName('Default search mode')
      .setDesc(isPartial ? 'Hybrid and Semantic require embeddings. Currently coerced to Keyword.' : '')
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

    // Default collection — prefer live names from qmd status; fall back to index.yml
    const collectionNames = liveCollectionNames ?? loadCollectionNames();
    new Setting(section)
      .setName('Default collection')
      .setDesc('Pre-selected collection in the search modal.')
      .addDropdown((dd) => {
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

    const formatDelay = (s: number) => s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
    const debounceValueEl = section.createEl('span', {
      text: formatDelay(this.plugin.settings.reindexDebounceSeconds),
      cls: 'qmd-slider-value',
    });
    new Setting(section)
      .setName('Reindex delay')
      .setDesc('Time to wait after the last file change before triggering a reindex. Range: 1s … 5m')
      .setClass('qmd-setting-with-value')
      .addSlider((slider) => {
        slider
          .setLimits(1, 300, 1)
          .setValue(this.plugin.settings.reindexDebounceSeconds)
          .onChange(async (value) => {
            debounceValueEl.setText(formatDelay(value));
            this.plugin.settings.reindexDebounceSeconds = value;
            await this.plugin.saveSettings(false);
          });
        slider.sliderEl.title = '1s … 5m';
      })
      .settingEl.append(debounceValueEl);

    // qmd binary path — read-only chip with Change… button (#6)
    const autoDetected = this.plugin.resolvedBinaryPath !== 'qmd' && this.plugin.settings.qmdBinaryPath === 'qmd';
    const displayPath = autoDetected ? this.plugin.resolvedBinaryPath : this.plugin.settings.qmdBinaryPath;

    const binarySetting = new Setting(section)
      .setName('qmd binary')
      .setDesc('Path to the qmd executable. Auto-detected from $PATH.');

    // Read-only chip showing resolved path
    const chipContainer = binarySetting.settingEl.createDiv({ cls: 'qmd-binary-chip-row' });
    const chip = chipContainer.createEl('span', {
      cls: `qmd-binary-chip${autoDetected ? ' qmd-binary-chip--auto' : ''}`,
      text: (autoDetected ? '✓ ' : '') + displayPath,
    });

    const changeBtn = chipContainer.createEl('button', { cls: 'qmd-binary-change-btn', text: 'Change…' });
    let editEl: HTMLInputElement | null = null;

    changeBtn.addEventListener('click', () => {
      if (editEl) return;
      chip.style.display = 'none';
      changeBtn.style.display = 'none';

      const editRow = chipContainer.createDiv({ cls: 'qmd-binary-edit-row' });
      editEl = editRow.createEl('input', {
        type: 'text',
        value: this.plugin.settings.qmdBinaryPath,
        placeholder: 'qmd',
        cls: 'qmd-binary-edit-input',
      });
      const saveBtn = editRow.createEl('button', { cls: 'mod-cta qmd-binary-save-btn', text: 'Save' });
      const cancelBtn = editRow.createEl('button', { cls: 'qmd-binary-cancel-btn', text: 'Cancel' });

      const cancel = () => {
        editRow.remove();
        editEl = null;
        chip.style.display = '';
        changeBtn.style.display = '';
      };

      const save = async () => {
        const val = editEl?.value.trim() ?? '';
        this.plugin.settings.qmdBinaryPath = val || 'qmd';
        await this.plugin.saveSettings();
        cancel();
        this.display();
      };

      saveBtn.addEventListener('click', () => void save());
      cancelBtn.addEventListener('click', cancel);
      editEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') void save();
        else if (e.key === 'Escape') cancel();
      });
      setTimeout(() => editEl?.focus(), 50);
    });

    // Insert chip row into the setting control area
    binarySetting.settingEl.querySelector('.setting-item-control')?.append(chipContainer);
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
            this.refreshStatusArea();
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
      .setDesc('Faster responses; BM25+vector fusion only. Equivalent to --no-rerank.')
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
      .setDesc('Max candidates sent to the LLM reranker. Leave blank for the qmd default (~40).')
      .addText((text) =>
        text
          .setPlaceholder('Default (~40)')
          .setValue(this.plugin.settings.candidateLimit != null && this.plugin.settings.candidateLimit > 0
            ? String(this.plugin.settings.candidateLimit)
            : '')
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.candidateLimit = isNaN(n) || n <= 0 ? undefined : n;
            await this.plugin.saveSettings(false);
          }),
      );

    new Setting(advancedEl)
      .setName('Minimum score')
      .setDesc('Filter results below this similarity score. Leave blank to disable.')
      .addText((text) =>
        text
          .setPlaceholder('Default (disabled)')
          .setValue(this.plugin.settings.minScore != null && this.plugin.settings.minScore > 0
            ? String(this.plugin.settings.minScore)
            : '')
          .onChange(async (value) => {
            const n = parseFloat(value);
            this.plugin.settings.minScore = isNaN(n) || n <= 0 ? undefined : n;
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

    // About — shows full version with build hash (#7)
    const aboutEl = advancedEl.createDiv({ cls: 'qmd-about-section' });
    aboutEl.createEl('p', { cls: 'qmd-about-label', text: 'About' });
    aboutEl.createEl('p', {
      cls: 'qmd-about-line',
      text: `plugin v${this.plugin.manifest.version}`,
    });
    if (this.plugin.resolvedBinaryPath !== 'qmd') {
      runVersion(this.plugin.resolvedBinaryPath).then((v) => {
        if (!aboutEl.isConnected) return;
        aboutEl.createEl('p', { cls: 'qmd-about-line', text: `qmd ${v}` });
      }).catch(() => { /* ignore */ });
    }
  }
}
