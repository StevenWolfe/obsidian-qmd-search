import type QmdSearchPlugin from '../main';
import type { QmdStatus } from '../client/types';

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return `${Math.floor(diffHr / 24)} days ago`;
}

export class StatusPopover {
  private el: HTMLElement | null = null;
  private removeListeners: (() => void)[] = [];

  constructor(private readonly plugin: QmdSearchPlugin) {}

  toggle(anchorEl: HTMLElement): void {
    if (this.el) {
      this.close();
    } else {
      this.open(anchorEl);
    }
  }

  open(anchorEl: HTMLElement): void {
    if (this.el) this.close();

    const el = document.body.createDiv({ cls: 'qmd-popover' });
    this.el = el;

    // Header row
    const header = el.createDiv({ cls: 'qmd-popover-header' });
    const statusDot = header.createSpan({ cls: 'qmd-dot qmd-dot--ok' });
    const statusLabel = header.createSpan({ cls: 'qmd-popover-status-label', text: 'Loading…' });
    const closeBtn = header.createEl('button', { cls: 'qmd-popover-close', text: '×' });
    closeBtn.addEventListener('click', () => this.close());
    // Suppress unused variable warning — dot is used for dynamic update
    void statusDot;

    // Body
    const body = el.createDiv({ cls: 'qmd-popover-body' });
    body.createEl('p', { cls: 'qmd-popover-loading', text: 'Loading…' });

    // Footer — primary CTA adapts to health state (#14)
    const footer = el.createDiv({ cls: 'qmd-popover-footer' });
    const ps = this.plugin.pluginStatus;
    const isPartial = ps.kind === 'idle' && (ps.health.kind === 'partial' || ps.health.kind === 'stale');

    if (isPartial) {
      // partial: primary = Generate embeddings
      const embedCta = footer.createEl('button', { cls: 'qmd-popover-btn mod-cta', text: '✨ Generate embeddings' });
      embedCta.addEventListener('click', () => { this.close(); void this.plugin.embed(); });
      const reindexBtn = footer.createEl('button', { cls: 'qmd-popover-btn', text: '↻ Re-index' });
      reindexBtn.setAttribute('title', 'Refresh text index (fast). Run before generating embeddings.');
      reindexBtn.addEventListener('click', () => { this.close(); void this.plugin.reindex(); });
    } else {
      // healthy: primary = Re-index
      const reindexBtn = footer.createEl('button', { cls: 'qmd-popover-btn mod-cta', text: '↻ Re-index' });
      reindexBtn.setAttribute('title', 'Update the text index (qmd update) — run after adding or editing notes');
      reindexBtn.addEventListener('click', () => { this.close(); void this.plugin.reindex(); });
      const embedBtn = footer.createEl('button', { cls: 'qmd-popover-btn', text: '✨ Generate embeddings' });
      embedBtn.setAttribute('title', 'Generate vector embeddings (qmd embed) — run after re-indexing to enable semantic search');
      embedBtn.addEventListener('click', () => { this.close(); void this.plugin.embed(); });
    }
    const settingsBtn = footer.createEl('button', { cls: 'qmd-popover-btn', text: 'Settings' });
    settingsBtn.addEventListener('click', () => {
      this.close();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.plugin.app as any).setting?.open?.();
    });

    // Position above anchor
    this.positionAbove(anchorEl);

    // Fetch and render status
    this.plugin.client.status().then((s) => {
      if (!this.el) return;
      body.empty();
      const totalDocs = s.totalDocs ?? s.collections.reduce((n, c) => n + c.docCount, 0);
      const totalVectors = s.totalVectors ?? 0;
      const isPartialStatus = totalDocs > 0 && totalVectors === 0;
      const isStaleStatus = totalVectors > 0 && totalVectors < totalDocs;
      if (isPartialStatus) {
        statusLabel.setText('Index partial — embeddings missing');
        statusDot.removeClass('qmd-dot--ok');
        statusDot.addClass('qmd-dot--warn');
      } else if (isStaleStatus) {
        statusLabel.setText('Index stale — some embeddings missing');
        statusDot.removeClass('qmd-dot--ok');
        statusDot.addClass('qmd-dot--warn');
      } else if (!s.healthy) {
        statusLabel.setText('Index unhealthy');
        statusDot.removeClass('qmd-dot--ok');
        statusDot.addClass('qmd-dot--err');
      } else {
        statusLabel.setText('Index healthy');
      }
      this.renderBody(body, s);
    }).catch((err: Error) => {
      if (!this.el) return;
      body.empty();
      statusLabel.setText('Error fetching status');
      statusDot.removeClass('qmd-dot--ok');
      statusDot.addClass('qmd-dot--err');
      body.createEl('p', { cls: 'qmd-popover-error', text: err.message });
    });

    // Close on outside click
    const onMousedown = (e: MouseEvent) => {
      if (this.el && !this.el.contains(e.target as Node) && e.target !== anchorEl) {
        this.close();
      }
    };
    document.addEventListener('mousedown', onMousedown);
    this.removeListeners.push(() => document.removeEventListener('mousedown', onMousedown));

    // Close on Escape
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', onKeydown);
    this.removeListeners.push(() => document.removeEventListener('keydown', onKeydown));
  }

  private renderBody(body: HTMLElement, s: QmdStatus): void {
    const totalDocs = s.totalDocs ?? s.collections.reduce((n, c) => n + c.docCount, 0);
    const totalVectors = s.totalVectors ?? 0;
    const lastIndexed = s.collections[0]?.lastIndexed;
    const embeddingsMissing = totalDocs > 0 && totalVectors < totalDocs;

    const rows: [string, string, boolean?][] = [
      ['Documents', totalDocs.toLocaleString()],
      ['Collections', `${s.collections.length} registered`],
      ['Embeddings', `${totalVectors.toLocaleString()} / ${totalDocs.toLocaleString()}`, embeddingsMissing],
    ];
    if (lastIndexed) rows.push(['Last indexed', timeAgo(lastIndexed)]);
    if (s.indexSize) rows.push(['Disk', s.indexSize]);

    const table = body.createEl('table', { cls: 'qmd-popover-table' });
    for (const [key, val, warn] of rows) {
      const row = table.createEl('tr');
      row.createEl('td', { cls: 'qmd-popover-key', text: key });
      row.createEl('td', { cls: `qmd-popover-val${warn ? ' qmd-popover-val--warn' : ''}`, text: val });
    }

    if (s.collections.length > 0) {
      const colSection = body.createDiv({ cls: 'qmd-popover-collections' });
      colSection.createEl('p', { cls: 'qmd-popover-section-title', text: 'Collections' });
      for (const col of s.collections) {
        const row = colSection.createDiv({ cls: 'qmd-popover-col-row' });
        row.createEl('span', { cls: 'qmd-popover-col-name', text: col.name });
        row.createEl('span', { cls: 'qmd-popover-col-meta', text: `${col.docCount.toLocaleString()} docs` });
        if (col.lastIndexed) {
          row.createEl('span', { cls: 'qmd-popover-col-time', text: timeAgo(col.lastIndexed) });
        }
      }
    }
  }

  private positionAbove(anchorEl: HTMLElement): void {
    const el = this.el;
    if (!el) return;

    const rect = anchorEl.getBoundingClientRect();
    el.style.position = 'fixed';
    el.style.width = '360px';
    // Position to right-align with anchor, above it
    const right = window.innerWidth - rect.right;
    el.style.right = `${Math.max(4, right)}px`;
    el.style.left = '';
    // Initially position off-screen to measure height
    el.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  }

  close(): void {
    for (const fn of this.removeListeners) fn();
    this.removeListeners = [];
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}
