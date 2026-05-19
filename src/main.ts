const { execFile } = require('child_process') as typeof import('child_process');

import { Notice, Plugin, TAbstractFile } from 'obsidian';
import { DEFAULT_SETTINGS, QmdSearchSettings, QmdSettingTab } from './settings';
import { setLogLevel, log } from './util/log';
import { buildEnv, initShellContext } from './util/env';
import type { QmdClient } from './client/base';
import { CliQmdClient } from './client/cli';
import { McpQmdClient } from './client/mcp';
import { SearchModal } from './ui/SearchModal';
import { StatusPopover } from './ui/StatusPopover';
import { OnboardingModal } from './ui/OnboardingModal';
import type { PluginStatus } from './client/types';
import { computeIndexHealth } from './client/types';

const STATUS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const TRANSIENT_DURATION_MS = 3000;
const MAX_RECENT_QUERIES = 5;

export default class QmdSearchPlugin extends Plugin {
  settings!: QmdSearchSettings;
  client!: QmdClient;
  modelLoaded = false;
  resolvedBinaryPath = 'qmd';

  pluginStatus: PluginStatus = { kind: 'unresolved' };
  recentQueries: string[] = [];

  mcpConnected = false;

  private statusBarItem!: HTMLElement;
  private statusPopover: StatusPopover | null = null;
  private transientTimer: number | null = null;
  private reindexTimer: number | null = null;
  private lastIdleStatus: PluginStatus & { kind: 'idle' } | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.recentQueries = this.settings.recentQueries ?? [];
    this.resolvedBinaryPath = await initShellContext(this.settings.qmdBinaryPath);
    log.debug('plugin loaded: binary=%s transport=%s', this.resolvedBinaryPath, this.settings.transportMode);
    this.client = this.buildClient();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass('qmd-status-bar');
    this.setPluginStatus({ kind: 'unresolved' });

    this.statusBarItem.addEventListener('click', () => this.handleStatusBarClick());

    // Initial status bar population after a short delay (client may be warming up)
    setTimeout(() => this.refreshStatusBar(), 3000);
    this.registerInterval(window.setInterval(() => this.refreshStatusBar(), STATUS_REFRESH_INTERVAL_MS));

    // Auto-reindex: watch for markdown file changes and debounce a re-index run
    const onVaultChange = (f: TAbstractFile) => { if (f.path.endsWith('.md')) this.scheduleReindex(); };
    this.registerEvent(this.app.vault.on('create', onVaultChange));
    this.registerEvent(this.app.vault.on('modify', onVaultChange));
    this.registerEvent(this.app.vault.on('delete', onVaultChange));

    this.addCommand({
      id: 'qmd-search',
      name: 'QMD: Search',
      callback: () => new SearchModal(this.app, this.client, this.settings, this).open(),
    });

    this.addCommand({
      id: 'qmd-reindex',
      name: 'QMD: Re-index collections',
      callback: () => this.reindex(),
    });

    this.addCommand({
      id: 'qmd-embed',
      name: 'QMD: Generate embeddings',
      callback: () => this.embed(),
    });

    this.addSettingTab(new QmdSettingTab(this.app, this));

    // Show onboarding after Obsidian has fully loaded
    setTimeout(() => {
      if (!this.settings.onboardingDone) {
        new OnboardingModal(this.app, this).open();
      }
    }, 500);
  }

  async onunload(): Promise<void> {
    if (this.statusPopover) {
      this.statusPopover.close();
      this.statusPopover = null;
    }
    if (this.reindexTimer !== null) {
      window.clearTimeout(this.reindexTimer);
      this.reindexTimer = null;
    }
    await this.client.dispose();
  }

  private scheduleReindex(): void {
    if (!this.settings.autoReindex) return;
    if (this.reindexTimer !== null) window.clearTimeout(this.reindexTimer);
    this.reindexTimer = window.setTimeout(() => {
      this.reindexTimer = null;
      void this.reindex();
    }, this.settings.reindexDebounceSeconds * 1000);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    setLogLevel(this.settings.logLevel);
  }

  async saveSettings(rebuildClient = true): Promise<void> {
    await this.saveData(this.settings);
    setLogLevel(this.settings.logLevel);
    if (rebuildClient) {
      this.client.dispose().catch(console.error);
      this.resolvedBinaryPath = await initShellContext(this.settings.qmdBinaryPath);
      this.client = this.buildClient();
      this.modelLoaded = false;
    }
  }

  /** Update pluginStatus and re-render the status bar DOM in-place. */
  setPluginStatus(s: PluginStatus): void {
    this.pluginStatus = s;
    if (s.kind === 'idle') this.lastIdleStatus = s;

    const el = this.statusBarItem;
    if (!el) return;

    el.empty();

    const dot = el.createSpan({ cls: 'qmd-dot' });
    el.createSpan({ cls: 'qmd-sb-label', text: 'qmd' });
    const value = el.createSpan({ cls: 'qmd-sb-value' });

    switch (s.kind) {
      case 'unresolved':
        value.setText('…');
        break;
      case 'empty':
        dot.addClass('qmd-dot--warn');
        value.setText('no index');
        break;
      case 'idle': {
        const h = s.health;
        if (h.kind === 'partial' || h.kind === 'stale') {
          dot.addClass('qmd-dot--warn');
          value.setText(`${s.docs.toLocaleString()} · no embeds`);
        } else if (this.settings.transportMode === 'mcp-http' && !this.mcpConnected) {
          dot.addClass('qmd-dot--warn');
          value.setText(`${s.docs.toLocaleString()} · CLI fallback`);
        } else {
          dot.addClass('qmd-dot--ok');
          value.setText(s.docs.toLocaleString());
        }
        break;
      }
      case 'indexing':
        dot.addClass('qmd-dot--accent');
        dot.addClass('qmd-dot--pulse');
        value.setText(`${s.done.toLocaleString()} / ${s.total.toLocaleString()}`);
        break;
      case 'error':
        dot.addClass('qmd-dot--err');
        value.setText(s.code === 'binary_missing' ? 'binary missing' : 'error');
        break;
      case 'transient':
        dot.addClass('qmd-dot--ok');
        value.setText(`${s.results} results · ${s.ms} ms`);
        break;
    }

    // Update tooltip
    el.setAttribute('title', this.statusTitle(s));
  }

  private statusTitle(s: PluginStatus): string {
    switch (s.kind) {
      case 'unresolved': return 'QMD: loading…';
      case 'empty': return 'QMD: no index — click to set up';
      case 'idle': {
        const h = s.health;
        if (h.kind === 'partial') return `QMD: ${s.docs.toLocaleString()} docs · embeddings missing — click for details`;
        if (h.kind === 'stale') return `QMD: ${s.docs.toLocaleString()} docs · embeddings outdated — click for details`;
        return `QMD: ${s.docs.toLocaleString()} docs · click for details`;
      }
      case 'indexing': return `QMD: indexing ${s.done} / ${s.total}`;
      case 'error': return `QMD: error — ${s.detail}`;
      case 'transient': return `QMD: ${s.results} results · ${s.ms}ms`;
    }
  }

  private handleStatusBarClick(): void {
    const s = this.pluginStatus;
    switch (s.kind) {
      case 'idle':
      case 'indexing':
        if (!this.statusPopover) {
          this.statusPopover = new StatusPopover(this);
        }
        this.statusPopover.toggle(this.statusBarItem);
        break;
      case 'empty':
        if (this.settings.onboardingDone) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.app as any).setting?.open?.();
        } else {
          new OnboardingModal(this.app, this).open();
        }
        break;
      case 'error':
        // binary_missing → jump straight to settings; otherwise show popover
        if (s.code === 'binary_missing') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.app as any).setting?.open?.();
        } else {
          if (!this.statusPopover) this.statusPopover = new StatusPopover(this);
          this.statusPopover.toggle(this.statusBarItem);
        }
        break;
      case 'transient':
        new SearchModal(this.app, this.client, this.settings, this).open();
        break;
      default:
        this.refreshStatusBar();
    }
  }

  async refreshStatusBar(): Promise<void> {
    if (!this.statusBarItem) return;
    if (this.resolvedBinaryPath === 'qmd') {
      this.setPluginStatus({ kind: 'error', detail: 'qmd binary not found', code: 'binary_missing' });
      return;
    }
    try {
      const s = await this.client.status();
      const totalDocs = s.totalDocs ?? s.collections.reduce((n, c) => n + c.docCount, 0);
      const totalVectors = s.totalVectors ?? 0;
      const lastIndexed = s.collections[0]?.lastIndexed;

      if (s.collections.length === 0) {
        this.setPluginStatus({ kind: 'empty' });
      } else {
        this.mcpConnected = this.settings.transportMode !== 'mcp-http' || s.healthy;
        this.setPluginStatus({
          kind: 'idle',
          docs: totalDocs,
          collections: s.collections.length,
          embeddings: totalVectors,
          lastIndexed,
          health: computeIndexHealth(totalDocs, totalVectors),
        });
      }
    } catch (err) {
      const msg = (err as Error).message ?? '';
      this.setPluginStatus({
        kind: 'error',
        detail: msg,
        code: msg.includes('not found') || msg.includes('ENOENT') ? 'binary_missing' : 'qmd_crash',
      });
    }
  }

  /** Record a query in recentQueries (deduped, max 5, most-recent first). */
  addRecentQuery(query: string): void {
    const q = query.trim();
    if (!q) return;
    this.recentQueries = [q, ...this.recentQueries.filter((r) => r !== q)].slice(0, MAX_RECENT_QUERIES);
    this.settings.recentQueries = this.recentQueries;
    this.saveSettings(false).catch(console.error);
  }

  /** Called after a search completes. Shows transient status, restores idle after 3s. */
  reportSearchResult(results: number, ms: number): void {
    if (this.transientTimer !== null) {
      window.clearTimeout(this.transientTimer);
      this.transientTimer = null;
    }
    this.setPluginStatus({ kind: 'transient', results, ms });
    this.transientTimer = window.setTimeout(() => {
      this.transientTimer = null;
      if (this.lastIdleStatus) {
        this.setPluginStatus(this.lastIdleStatus);
      }
    }, TRANSIENT_DURATION_MS);
  }

  reindex(): Promise<void> {
    const notice = new Notice('QMD: re-indexing collections…', 0);
    this.showOperationInStatusBar('indexing…');
    const args = this.settings.indexName ? ['--index', this.settings.indexName, 'update'] : ['update'];
    return new Promise((resolve) => {
      execFile(this.resolvedBinaryPath, args, { timeout: 600_000, env: buildEnv() }, (err) => {
        notice.hide();
        if (err) new Notice(`QMD: re-index error — ${err.message}`);
        else new Notice('QMD: re-index complete ✓');
        this.refreshStatusBar();
        resolve();
      });
    });
  }

  embed(): Promise<void> {
    const notice = new Notice('QMD: generating embeddings…', 0);
    this.showOperationInStatusBar('embedding…');
    const args = this.settings.indexName ? ['--index', this.settings.indexName, 'embed'] : ['embed'];
    return new Promise((resolve) => {
      execFile(this.resolvedBinaryPath, args, { timeout: 600_000, env: buildEnv() }, (err) => {
        notice.hide();
        if (err) new Notice(`QMD: embed error — ${err.message}`);
        else new Notice('QMD: embeddings complete ✓');
        this.refreshStatusBar();
        resolve();
      });
    });
  }

  /** Immediately render a pulsing in-progress label in the status bar chip. */
  private showOperationInStatusBar(label: string): void {
    const el = this.statusBarItem;
    if (!el) return;
    el.empty();
    el.createSpan({ cls: 'qmd-dot qmd-dot--accent qmd-dot--pulse' });
    el.createSpan({ cls: 'qmd-sb-label', text: 'qmd' });
    el.createSpan({ cls: 'qmd-sb-value', text: label });
    el.setAttribute('title', `QMD: ${label}`);
  }

  private buildClient(): QmdClient {
    if (this.settings.transportMode === 'mcp-http') {
      const c = new McpQmdClient(this.resolvedBinaryPath, this.settings.mcpPort);
      c.init().catch((err: Error) => {
        new Notice(`QMD: Failed to start MCP daemon — ${err.message}`);
      });
      return c;
    }
    return new CliQmdClient(this.resolvedBinaryPath, this.settings.indexName);
  }
}
