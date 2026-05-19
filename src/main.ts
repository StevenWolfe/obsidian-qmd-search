// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process') as typeof import('child_process');

import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, QmdSearchSettings, QmdSettingTab } from './settings';
import { setLogLevel, log } from './util/log';
import { buildEnv, initShellContext } from './util/env';
import type { QmdClient } from './client/base';
import { CliQmdClient } from './client/cli';
import { McpQmdClient } from './client/mcp';
import { SearchModal } from './ui/SearchModal';
import { StatusModal } from './ui/StatusModal';

const STATUS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export default class QmdSearchPlugin extends Plugin {
  settings!: QmdSearchSettings;
  client!: QmdClient;
  modelLoaded = false;
  resolvedBinaryPath = 'qmd';

  private statusBarItem!: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.resolvedBinaryPath = await initShellContext(this.settings.qmdBinaryPath);
    log.debug('plugin loaded: binary=%s transport=%s', this.resolvedBinaryPath, this.settings.transportMode);
    this.client = this.buildClient();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass('qmd-status-bar');
    this.statusBarItem.setAttribute('title', 'QMD index status — click to refresh');
    this.statusBarItem.addEventListener('click', () => this.refreshStatusBar());

    // Initial status bar population after a short delay (client may be warming up)
    setTimeout(() => this.refreshStatusBar(), 3000);
    this.registerInterval(window.setInterval(() => this.refreshStatusBar(), STATUS_REFRESH_INTERVAL_MS));

    this.addCommand({
      id: 'qmd-search',
      name: 'QMD: Search',
      callback: () => new SearchModal(this.app, this.client, this.settings, this).open(),
    });

    this.addCommand({
      id: 'qmd-status',
      name: 'QMD: Index status',
      callback: () => new StatusModal(this.app, this).open(),
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
  }

  async onunload(): Promise<void> {
    await this.client.dispose();
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

  async refreshStatusBar(): Promise<void> {
    if (!this.statusBarItem) return;
    if (this.resolvedBinaryPath === 'qmd') {
      this.statusBarItem.setText('qmd ✗');
      this.statusBarItem.className = 'qmd-status-bar qmd-status-bar--err';
      return;
    }
    try {
      const s = await this.client.status();
      const total = s.collections.reduce((n, c) => n + c.docCount, 0);

      let stale = false;
      const threshold = Date.now() - STALE_THRESHOLD_MS;
      for (const col of s.collections) {
        if (col.lastIndexed) {
          const d = new Date(col.lastIndexed);
          if (!isNaN(d.getTime()) && d.getTime() < threshold) { stale = true; break; }
        }
      }

      if (stale) {
        this.statusBarItem.setText(`qmd ⚠ ${total.toLocaleString()}`);
        this.statusBarItem.className = 'qmd-status-bar qmd-status-bar--warn';
        this.statusBarItem.setAttribute('title', 'QMD: index may be stale — click to refresh');
      } else {
        this.statusBarItem.setText(`qmd ${total.toLocaleString()}`);
        this.statusBarItem.className = 'qmd-status-bar qmd-status-bar--ok';
        this.statusBarItem.setAttribute('title', 'QMD index status — click to refresh');
      }
    } catch {
      this.statusBarItem.setText('qmd ✗');
      this.statusBarItem.className = 'qmd-status-bar qmd-status-bar--err';
    }
  }

  reindex(): Promise<void> {
    const notice = new Notice('QMD: re-indexing collections…', 0);
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
