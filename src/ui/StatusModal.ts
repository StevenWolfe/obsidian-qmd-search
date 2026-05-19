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

    // Health
    const healthRow = body.createDiv({ cls: 'qmd-status-health' });
    healthRow.createEl('span', {
      text: status.healthy ? '✓ Healthy' : '✗ Unhealthy',
      cls: status.healthy ? 'qmd-status-ok' : 'qmd-status-err',
    });
    if (status.message) {
      healthRow.createEl('span', { text: ` — ${status.message}`, cls: 'qmd-status-message' });
    }

    // Index
    if (status.indexPath || status.indexSize) {
      const rows: [string, string][] = [];
      if (status.indexPath) rows.push(['Path', status.indexPath]);
      if (status.indexSize) rows.push(['Size', status.indexSize]);
      this.renderSection(body, 'Index', rows);
    }

    // Documents
    if (status.totalDocs !== undefined || status.totalVectors !== undefined) {
      const rows: [string, string][] = [];
      if (status.totalDocs !== undefined) rows.push(['Files indexed', String(status.totalDocs)]);
      if (status.totalVectors !== undefined) rows.push(['Embedded', String(status.totalVectors)]);
      this.renderSection(body, 'Documents', rows);
    }

    // Collections
    const collSection = body.createDiv({ cls: 'qmd-status-section' });
    collSection.createEl('h3', { text: 'Collections', cls: 'qmd-status-section-heading' });
    if (status.collections.length > 0) {
      const table = collSection.createEl('table', { cls: 'qmd-status-table' });
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
      collSection.createEl('p', { text: 'No collections registered.', cls: 'qmd-muted' });
    }

    // AST Chunking
    if (status.astChunkingActive !== undefined || status.astLanguages?.length) {
      const rows: [string, string][] = [];
      if (status.astChunkingActive !== undefined) {
        rows.push(['Status', status.astChunkingActive ? 'active' : 'inactive']);
      }
      if (status.astLanguages?.length) {
        rows.push(['Languages', status.astLanguages.join(', ')]);
      }
      this.renderSection(body, 'AST Chunking', rows);
    }

    // Models
    if (status.embeddingModel || status.rerankingModel || status.generationModel) {
      const rows: [string, string][] = [];
      if (status.embeddingModel) rows.push(['Embedding', status.embeddingModel]);
      if (status.rerankingModel) rows.push(['Reranking', status.rerankingModel]);
      if (status.generationModel) rows.push(['Generation', status.generationModel]);
      this.renderSection(body, 'Models', rows);
    }

    // Device
    if (status.gpuInfo || status.gpuDevice || status.gpuVram || status.cpuCores) {
      const rows: [string, string][] = [];
      if (status.gpuInfo) rows.push(['GPU', status.gpuInfo]);
      if (status.gpuDevice) rows.push(['Device', status.gpuDevice]);
      if (status.gpuVram) rows.push(['VRAM', status.gpuVram]);
      if (status.cpuCores) rows.push(['CPU', status.cpuCores]);
      this.renderSection(body, 'Device', rows);
    }
  }

  private renderSection(parent: HTMLElement, title: string, rows: [string, string][]): void {
    const section = parent.createDiv({ cls: 'qmd-status-section' });
    section.createEl('h3', { text: title, cls: 'qmd-status-section-heading' });
    const table = section.createEl('table', { cls: 'qmd-status-kv-table' });
    for (const [key, value] of rows) {
      const row = table.createEl('tr');
      row.createEl('td', { text: key, cls: 'qmd-kv-key' });
      row.createEl('td', { text: value, cls: 'qmd-kv-value' });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
