const { execFile } = require('child_process') as typeof import('child_process');
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');

import { App, PluginSettingTab, Setting, Notice, Menu, Modal } from 'obsidian';
import type QmdSearchPlugin from './main';
import { type LogLevel, setLogLevel, log } from './util/log';
import { buildEnv } from './util/env';
import { timeAgo } from './util/time';
import { computeIndexHealth, type IndexHealth, type QmdStatus, type QmdCollectionStatus } from './client/types';
import { buildDiagnosticsReport, postReport } from './util/telemetry';

// Fallback if status call fails
function loadCollectionNames(): string[] {
  return [];
}

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
  prewarmOnLaunch: boolean;
  searchAhead: boolean;
  telemetryEnabled: boolean;
}

export const DEFAULT_SETTINGS: QmdSearchSettings = {
  qmdBinaryPath: 'qmd',
  indexName: '',
  transportMode: 'cli',
  mcpPort: 8181,
  defaultCollection: '',
  defaultSearchMode: 'semantic',
  noRerank: false,
  candidateLimit: undefined,
  minScore: undefined,
  logLevel: 'error',
  recentQueries: [],
  onboardingDone: false,
  autoReindex: false,
  reindexDebounceSeconds: 90,
  prewarmOnLaunch: true,
  searchAhead: true,
  telemetryEnabled: false,
};

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
      const version = this.plugin.manifest.version;
      const { shell } = require('electron') as typeof import('electron');
      void shell.openExternal(`https://stevenwolfe.github.io/obsidian-qmd-search/docs/${version}`);
    });
    headerMeta.createSpan({ text: ' · ' });
    const binaryPill = headerMeta.createSpan({ cls: 'qmd-binary-pill qmd-binary-pill--checking', text: 'checking…' });

    if (this.plugin.resolvedBinaryPath !== 'qmd') {
      runVersion(this.plugin.resolvedBinaryPath).then((v) => {
        if (!binaryPill.isConnected) return;
        binaryPill.setText(v);
        binaryPill.removeClass('qmd-binary-pill--checking');
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
    this.loadContent(contentArea, wasAdvancedOpen, true);
  }

  private loadContent(contentArea: HTMLElement, wasAdvancedOpen: boolean, isRefreshing = false): void {
    if (isRefreshing) {
      contentArea.addClass('qmd-is-loading');
    } else {
      contentArea.empty();
      contentArea.createEl('p', { cls: 'qmd-loading', text: 'Loading index status…' });
    }

    this.plugin.client.status().then((status) => {
      if (!contentArea.isConnected) return;

      const normPath = (p: string) => p.replace(/\/+$/, '');
      const vaultPath = normPath((this.app.vault.adapter as { basePath?: string }).basePath ?? '');
      const matched = status.collections.find(
        (c) => c.path !== undefined && normPath(c.path) === vaultPath,
      );

      // Build into a detached element then swap atomically — avoids blank-flash during refresh
      const renderTarget = document.createElement('div') as HTMLElement;
      if (status.collections.length === 0) {
        this.renderFirstRun(renderTarget, wasAdvancedOpen);
      } else {
        const totalDocs = status.totalDocs ?? status.collections.reduce((n, c) => n + c.docCount, 0);
        const totalVectors = status.totalVectors ?? 0;
        const health = computeIndexHealth(totalDocs, totalVectors);
        this.renderHealthy(renderTarget, status, health, wasAdvancedOpen, matched);
      }
      contentArea.empty();
      contentArea.removeClass('qmd-is-loading');
      while (renderTarget.firstChild) contentArea.appendChild(renderTarget.firstChild);
      this.startTimeTick();
    }).catch((err: Error) => {
      log.error('settings status failed:', err.message);
      if (!contentArea.isConnected) return;

      const renderTarget = document.createElement('div') as HTMLElement;
      this.renderFirstRun(renderTarget, wasAdvancedOpen, err.message);
      contentArea.empty();
      contentArea.removeClass('qmd-is-loading');
      while (renderTarget.firstChild) contentArea.appendChild(renderTarget.firstChild);
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
    this.renderRegistrationCard(container, true, errorMsg);
    this.renderGeneralSettings(container);
    this.renderAdvancedSection(container, wasAdvancedOpen);
  }

  private renderRegistrationCard(container: HTMLElement, isFirstRun: boolean, errorMsg?: string): void {
    const card = container.createDiv({ cls: 'qmd-empty-card' });
    card.createEl('div', { cls: 'qmd-empty-card-icon', text: isFirstRun ? '🗄' : '📍' });
    const cardBody = card.createDiv({ cls: 'qmd-empty-card-body' });
    cardBody.createEl('strong', { text: isFirstRun ? 'Index your vault to start searching' : 'This vault is not registered' });
    cardBody.createEl('p', {
      cls: 'qmd-muted',
      text: errorMsg
        ? `Error: ${errorMsg}`
        : isFirstRun
          ? 'QMD hasn\'t seen this vault yet. Indexing runs locally and takes about 30s per 1,000 notes.'
          : 'You can search other collections, but this vault hasn\'t been indexed for search yet.',
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
        indexBtn.textContent = 'Indexing…';
        new Notice(`QMD: indexing files for "${name}"…`);
        await this.plugin.reindex();
        indexBtn.textContent = 'Embedding…';
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
  }

  private renderHealthy(
    container: HTMLElement,
    status: QmdStatus,
    health: IndexHealth,
    wasAdvancedOpen: boolean,
    matched?: QmdCollectionStatus,
  ): void {
    if (!matched) {
      this.renderRegistrationCard(container, false);
    }

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
    } else if (matched) {
      cardHeader.createEl('strong', { text: matched.name });
      cardHeader.createSpan({ cls: 'qmd-col-badge', text: 'indexed' });
      if (matched.lastIndexed) {
        const timeEl = cardHeader.createEl('span', { cls: 'qmd-health-meta' });
        timeEl.dataset.lastIndexed = matched.lastIndexed;
        timeEl.setText(`Last indexed ${timeAgo(matched.lastIndexed)}`);
      }
    } else {
      cardHeader.createEl('strong', { text: 'Other collections indexed' });
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

    // Stats row — show vault-specific doc count when matched, global totals otherwise
    const statsRow = card.createDiv({ cls: 'qmd-health-stats' });
    const displayDocs = matched ? matched.docCount : totalDocs;
    const embeddingsStr = isPartial
      ? `0 / ${displayDocs.toLocaleString()}`
      : `${totalVectors.toLocaleString()} / ${totalDocs.toLocaleString()}`;
    const statItems: Array<[string, string, boolean?]> = [
      ['Documents', displayDocs.toLocaleString()],
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
    const addBtn = collHeader.createEl('button', { cls: 'qmd-section-btn', text: matched ? '+ Add other vault' : '+ Add collection' });
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
      const isMatched = col.name === matched?.name;
      const row = collList.createDiv({ cls: `qmd-collection-row${isMatched ? ' qmd-collection-row--active' : ''}` });
      row.createEl('span', { cls: 'qmd-col-icon', text: '🗄' });
      const primary = row.createDiv({ cls: 'qmd-col-primary' });
      const nameRow = primary.createDiv({ cls: 'qmd-col-name-row' });
      nameRow.createEl('span', { cls: 'qmd-col-name', text: col.name });
      if (isMatched) {
        nameRow.createSpan({ cls: 'qmd-col-badge', text: 'Current' });
      }
      if (col.path) {
        const shortPath = col.path.replace(os.homedir(), '~');
        primary.createEl('span', { cls: 'qmd-col-path qmd-muted', text: shortPath });
      }
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
          item.setTitle('Generate embeddings').setIcon('zap').onClick(async () => {
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
          .addOption('semantic', 'Semantic (default)')
          .addOption('hybrid', 'Hybrid — AI reranking (~2.5 GB extra models)')
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

    // ── Telemetry & diagnostics ───────────────────────────────────────────────
    new Setting(section)
      .setName('Usage analytics')
      .setDesc('Background collection of timing and index stats to ~/.cache/qmd/telemetry.jsonl. Opt-in, stored on your machine only, never uploaded automatically. For the plugin author\'s personal testing — not a third-party analytics service.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.telemetryEnabled)
          .onChange(async (value) => {
            this.plugin.settings.telemetryEnabled = value;
            await this.plugin.saveSettings(false);
          }),
      );

    // Diagnostics card — always available, not gated by telemetry toggle
    const diagCard = section.createDiv({ cls: 'qmd-diag-card' });
    diagCard.createEl('div', { cls: 'qmd-diag-label', text: 'Diagnostics report' });
    diagCard.createEl('p', {
      cls: 'qmd-muted',
      text: 'Snapshot of version, index, hardware, and recent timings. Useful for bug reports.',
    });

    const diagBtnRow = diagCard.createDiv({ cls: 'qmd-diag-btn-row' });

    const makeSettingsSnap = () => ({
      transportMode:      this.plugin.settings.transportMode,
      defaultSearchMode:  this.plugin.settings.defaultSearchMode,
      noRerank:           this.plugin.settings.noRerank,
      indexName:          this.plugin.settings.indexName,
      logLevel:           this.plugin.settings.logLevel,
      telemetryEnabled:   this.plugin.settings.telemetryEnabled,
    });

    const copyBtn = diagBtnRow.createEl('button', { cls: 'qmd-diag-btn', text: '📋 Copy' });
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(buildDiagnosticsReport(makeSettingsSnap()))
        .then(() => new Notice('QMD: diagnostics copied to clipboard ✓'))
        .catch(() => new Notice('QMD: clipboard write failed'));
    });

    const shareBtn = diagBtnRow.createEl('button', { cls: 'qmd-diag-btn', text: '📤 Share…' });
    diagCard.createEl('p', {
      cls: 'qmd-muted',
      text: 'Share uploads a one-time snapshot to a private URL — independent of the analytics toggle.',
    });
    const shareResult = diagCard.createDiv({ cls: 'qmd-diag-share-result qmd-diag-share-result--hidden' });

    shareBtn.addEventListener('click', async () => {
      shareBtn.disabled = true;
      shareBtn.textContent = '⏳ Uploading…';
      shareResult.addClass('qmd-diag-share-result--hidden');
      try {
        const url = await postReport(buildDiagnosticsReport(makeSettingsSnap()));
        shareResult.empty();
        shareResult.removeClass('qmd-diag-share-result--hidden');
        const urlEl = shareResult.createEl('a', { cls: 'qmd-diag-url', href: url, text: url });
        urlEl.addEventListener('click', (e: MouseEvent) => {
          e.preventDefault();
          window.open(url, '_blank');
        });
        shareResult.createEl('p', {
          cls: 'qmd-diag-privacy-warn',
          text: '⚠ Not private — anyone with this URL can view the contents. Share only with developers.',
        });
      } catch (err) {
        new Notice(`QMD: share failed — ${(err as Error).message}`);
      } finally {
        shareBtn.textContent = '📤 Share…';
        shareBtn.disabled = false;
      }
    });

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
      window.setTimeout(() => editEl?.focus(), 50);
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
      .setName('Pre-warm on launch')
      .setDesc('Automatically start the qmd daemon and load models when Obsidian starts. Recommended for fast first-queries.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.prewarmOnLaunch)
          .onChange(async (value) => {
            this.plugin.settings.prewarmOnLaunch = value;
            await this.plugin.saveSettings(false);
          }),
      );

    new Setting(advancedEl)
      .setName('Search ahead (instant fallback)')
      .setDesc('While waiting for Hybrid/Semantic results, show Keyword results immediately. Makes search feel instant.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.searchAhead)
          .onChange(async (value) => {
            this.plugin.settings.searchAhead = value;
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
        aboutEl.createEl('p', { cls: 'qmd-about-line', text: v });
      }).catch(() => { /* ignore */ });
    }
  }
}

export class CollectionNameModal extends Modal {
  private resolved = false;
  private result: string | null = null;

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
      const name = input.value.trim() || this.defaultValue;
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
    window.setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  onClose(): void {
    if (!this.resolved) { this.resolved = true; this.onSubmit(null); }
    this.contentEl.empty();
  }
}

async function runVersion(binary: string): Promise<string> {
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
