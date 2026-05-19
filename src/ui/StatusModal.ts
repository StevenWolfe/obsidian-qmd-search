import { App, Modal } from 'obsidian';
import type QmdSearchPlugin from '../main';
import type { QmdStatus } from '../client/types';

export class StatusModal extends Modal {
  private bodyEl!: HTMLElement;

  constructor(app: App, private readonly plugin: QmdSearchPlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass('qmd-status-modal');
    contentEl.createEl('h2', { text: 'QMD Index Status' });

    this.bodyEl = contentEl.createDiv({ cls: 'qmd-status-body' });

    const actionRow = contentEl.createDiv({ cls: 'qmd-action-row' });

    const reindexBtn = actionRow.createEl('button', { text: 'Re-index', cls: 'mod-cta' });
    reindexBtn.addEventListener('click', async () => {
      reindexBtn.disabled = true;
      reindexBtn.textContent = 'Re-indexing…';
      await this.plugin.reindex();
      if (reindexBtn.isConnected) {
        reindexBtn.disabled = false;
        reindexBtn.textContent = 'Re-index';
      }
      void this.renderStatus();
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
      void this.renderStatus();
    });

    const refreshBtn = actionRow.createEl('button', { text: 'Refresh' });
    refreshBtn.addEventListener('click', () => {
      void this.renderStatus();
      this.plugin.refreshStatusBar();
    });

    await this.renderStatus();
  }

  private async renderStatus(): Promise<void> {
    const body = this.bodyEl;
    body.empty();
    body.createEl('p', { text: 'Loading…', cls: 'qmd-status-loading' });

    let status: QmdStatus;
    try {
      status = await this.plugin.client.status();
    } catch (err) {
      if (!body.isConnected) return;
      body.empty();
      body.createEl('p', {
        text: `Error fetching status: ${(err as Error).message}`,
        cls: 'qmd-error',
      });
      return;
    }

    if (!body.isConnected) return;
    body.empty();

    const healthRow = body.createDiv({ cls: 'qmd-status-health' });
    healthRow.createEl('span', {
      text: status.healthy ? '✓ Healthy' : '✗ Unhealthy',
      cls: status.healthy ? 'qmd-status-ok' : 'qmd-status-err',
    });
    if (status.message) {
      healthRow.createEl('span', { text: status.message, cls: 'qmd-status-message' });
    }

    if (status.collections.length > 0) {
      const table = body.createEl('table', { cls: 'qmd-status-table' });
      const head = table.createEl('thead').createEl('tr');
      head.createEl('th', { text: 'Collection' });
      head.createEl('th', { text: 'Documents' });
      head.createEl('th', { text: 'Last indexed' });

      const tbody = table.createEl('tbody');
      for (const col of status.collections) {
        const row = tbody.createEl('tr');
        row.createEl('td', { text: col.name });
        row.createEl('td', { text: String(col.docCount) });
        row.createEl('td', { text: col.lastIndexed ?? '—' });
      }
    } else {
      body.createEl('p', { text: 'No collections found.', cls: 'qmd-muted' });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
