const path = require('path') as typeof import('path');

import { App, Modal } from 'obsidian';
import type { QmdClient } from '../client/base';
import type { QmdSearchSettings } from '../settings';
import type { QmdResult, SearchMode } from '../client/types';
import { loadCollectionNames } from '../util/config';
import { navigateToResult } from '../util/navigate';
import { log } from '../util/log';
import type QmdSearchPlugin from '../main';

const SUGGESTION_CHIPS = [
  'notes about my homelab',
  'decisions I made last week',
  'unfinished drafts',
];

/** Sanitize snippet HTML — allow only <mark> tags */
function sanitizeSnippet(html: string): string {
  return html.replace(/<(?!\/?mark\b)[^>]+>/gi, '');
}

/** Render 5-bar score indicator */
function buildScoreBars(score: number): HTMLElement {
  const container = document.createElement('span');
  container.className = 'qmd-score-bars';
  const filled = Math.round(score * 5);
  for (let i = 0; i < 5; i++) {
    const bar = container.createDiv({ cls: i < filled ? 'qmd-score-bar qmd-score-bar--filled' : 'qmd-score-bar' });
    void bar;
  }
  return container;
}

export class SearchModal extends Modal {
  private queryInput!: HTMLInputElement;
  private collectionSelect!: HTMLSelectElement;
  private activeMode: SearchMode;
  private resultsEl!: HTMLElement;
  private statusLine!: HTMLElement;
  private footerMode!: HTMLElement;
  private embeddingsAvailable = true;

  // For keyboard navigation
  private focusedIndex = -1;
  private resultItems: HTMLElement[] = [];

  // Debounce / cancellation
  private debounceTimer: number | null = null;
  private searchGeneration = 0;

  constructor(
    app: App,
    private readonly client: QmdClient,
    private readonly settings: QmdSearchSettings,
    private readonly plugin: QmdSearchPlugin,
  ) {
    super(app);
    // Determine if embeddings are available from current plugin status
    const ps = plugin.pluginStatus;
    if (ps.kind === 'idle') {
      this.embeddingsAvailable = ps.health.kind !== 'partial' && ps.health.kind !== 'empty';
    }
    // Coerce mode to keyword if embeddings not available
    const desired = settings.defaultSearchMode;
    this.activeMode = (!this.embeddingsAvailable && (desired === 'semantic' || desired === 'hybrid'))
      ? 'keyword'
      : desired;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass('qmd-search-modal');

    // ── Search bar ─────────────────────────────────────────────
    const searchBar = contentEl.createDiv({ cls: 'qmd-search-bar' });
    const searchIcon = searchBar.createSpan({ cls: 'qmd-search-icon', text: '🔍' });
    void searchIcon;

    this.queryInput = searchBar.createEl('input', {
      type: 'text',
      cls: 'qmd-query-input',
      attr: { placeholder: 'Search your notes…', 'aria-label': 'Search query' },
    });

    // ── Toolbar ────────────────────────────────────────────────
    const toolbar = contentEl.createDiv({ cls: 'qmd-toolbar' });

    // Mode segmented control — disable Semantic/Hybrid when embeddings missing (#10)
    const modeGroup = toolbar.createDiv({ cls: 'qmd-mode-group' });
    for (const [label, value] of [
      ['Keyword', 'keyword'],
      ['Semantic', 'semantic'],
      ['Hybrid', 'hybrid'],
    ] as [string, SearchMode][]) {
      const needsEmbeds = value === 'semantic' || value === 'hybrid';
      const disabled = needsEmbeds && !this.embeddingsAvailable;
      const btn = modeGroup.createEl('button', { text: label, cls: 'qmd-mode-btn' });
      if (value === this.activeMode) btn.addClass('qmd-mode-btn--active');
      if (disabled) {
        btn.addClass('qmd-mode-btn--disabled');
        btn.setAttribute('title', 'Generate embeddings first');
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.addEventListener('click', () => {
          this.activeMode = value;
          modeGroup.querySelectorAll('.qmd-mode-btn').forEach((b) => b.classList.remove('qmd-mode-btn--active'));
          btn.addClass('qmd-mode-btn--active');
          this.updateFooterMode();
          if (this.queryInput.value.trim()) this.scheduleSearch();
        });
      }
    }

    // "in" label + collection select
    toolbar.createEl('span', { cls: 'qmd-toolbar-in', text: 'in' });
    this.collectionSelect = toolbar.createEl('select', { cls: 'qmd-collection-select' });
    this.collectionSelect.createEl('option', { value: '', text: 'All collections' });
    // Prefer live collection names from plugin status, fall back to index.yml
    const ps = this.plugin.pluginStatus;
    const liveCollections = ps.kind === 'idle' ? ps.collections : 0;
    void liveCollections;
    for (const name of loadCollectionNames()) {
      this.collectionSelect.createEl('option', { value: name, text: name });
    }
    if (this.settings.defaultCollection) {
      this.collectionSelect.value = this.settings.defaultCollection;
    }
    this.collectionSelect.addEventListener('change', () => {
      if (this.queryInput.value.trim()) this.scheduleSearch();
    });

    // Status chip (shows result count or is empty)
    this.statusLine = toolbar.createEl('span', { cls: 'qmd-status-chip' });

    // ── Embeddings warn banner (#10) ────────────────────────────
    if (!this.embeddingsAvailable) {
      const banner = contentEl.createDiv({ cls: 'qmd-embeds-warn-banner' });
      banner.createSpan({ text: 'Semantic & Hybrid are disabled until embeddings are built.' });
      const generateBtn = banner.createEl('button', {
        cls: 'qmd-embeds-generate-btn',
        text: '✨ Generate',
      });
      generateBtn.addEventListener('click', () => {
        this.close();
        void this.plugin.embed();
      });
    }

    // ── Results / empty state ──────────────────────────────────
    this.resultsEl = contentEl.createDiv({ cls: 'qmd-results' });
    this.renderEmptyState();

    // ── Footer ─────────────────────────────────────────────────
    const footer = contentEl.createDiv({ cls: 'qmd-search-footer' });
    footer.createEl('span', { cls: 'qmd-footer-hint', text: '↑↓ navigate' });
    footer.createEl('span', { cls: 'qmd-footer-sep', text: '·' });
    footer.createEl('span', { cls: 'qmd-footer-hint', text: '↵ open' });
    footer.createEl('span', { cls: 'qmd-footer-sep', text: '·' });
    footer.createEl('span', { cls: 'qmd-footer-hint', text: '⌘↵ new tab' });
    this.footerMode = footer.createEl('span', { cls: 'qmd-footer-mode' });
    this.updateFooterMode();

    // ── Event listeners ────────────────────────────────────────
    this.queryInput.addEventListener('input', () => this.scheduleSearch());
    this.queryInput.addEventListener('keydown', (e: KeyboardEvent) => this.handleKeydown(e));

    this.queryInput.focus();
  }

  private updateFooterMode(): void {
    if (!this.footerMode) return;
    if (!this.embeddingsAvailable && (this.activeMode === 'semantic' || this.activeMode === 'hybrid')) {
      this.footerMode.setText('keyword (BM25) — fallback');
    } else if (this.activeMode === 'hybrid') {
      this.footerMode.setText('hybrid · BM25 + vectors + rerank');
    } else if (this.activeMode === 'semantic') {
      this.footerMode.setText('semantic · vectors');
    } else {
      this.footerMode.setText('keyword (BM25)');
    }
  }

  private scheduleSearch(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      const query = this.queryInput.value.trim();
      if (query) {
        void this.runSearch(query);
      } else {
        this.renderEmptyState();
        this.statusLine.setText('');
      }
    }, 120);
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.moveFocus(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.focusedIndex >= 0 && this.focusedIndex < this.resultItems.length) {
        const item = this.resultItems[this.focusedIndex];
        if (e.metaKey || e.ctrlKey) {
          item.dispatchEvent(new CustomEvent('qmd-open-new-tab'));
        } else {
          item.dispatchEvent(new CustomEvent('qmd-open'));
        }
      } else if (this.queryInput.value.trim()) {
        this.scheduleSearch();
      }
    }
  }

  private moveFocus(delta: number): void {
    if (this.resultItems.length === 0) return;
    this.focusedIndex = Math.max(0, Math.min(this.resultItems.length - 1, this.focusedIndex + delta));
    this.resultItems.forEach((el, i) => {
      el.classList.toggle('qmd-result-item--focused', i === this.focusedIndex);
    });
    this.resultItems[this.focusedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private renderEmptyState(): void {
    this.resultsEl.empty();
    this.focusedIndex = -1;
    this.resultItems = [];

    const recentQueries = this.plugin.recentQueries;

    if (recentQueries.length > 0) {
      const section = this.resultsEl.createDiv({ cls: 'qmd-empty-section' });
      section.createEl('div', { cls: 'qmd-empty-section-label', text: 'RECENT' });
      for (const q of recentQueries) {
        const row = section.createDiv({ cls: 'qmd-recent-item' });
        row.createSpan({ cls: 'qmd-recent-icon', text: '🕐' });
        row.createEl('span', { cls: 'qmd-recent-query', text: q });
        row.addEventListener('click', () => {
          this.queryInput.value = q;
          void this.runSearch(q);
        });
      }
    }

    // Check if any collection has docs (for suggestion chips)
    const status = this.plugin.pluginStatus;
    const hasDocs = status.kind === 'idle' && status.docs >= 50;

    if (hasDocs) {
      const trySection = this.resultsEl.createDiv({ cls: 'qmd-empty-section' });
      trySection.createEl('div', { cls: 'qmd-empty-section-label', text: 'TRY' });
      const chips = trySection.createDiv({ cls: 'qmd-suggestion-chips' });
      for (const chip of SUGGESTION_CHIPS) {
        const c = chips.createEl('button', { cls: 'qmd-chip', text: chip });
        c.addEventListener('click', () => {
          this.queryInput.value = chip;
          void this.runSearch(chip);
        });
      }
    }
  }

  private async runSearch(query: string): Promise<void> {
    const gen = ++this.searchGeneration;

    this.resultsEl.empty();
    this.focusedIndex = -1;
    this.resultItems = [];
    this.resultsEl.createEl('p', { cls: 'qmd-searching', text: 'Searching…' });

    const t0 = Date.now();
    let results: QmdResult[] | null = null;
    let searchError: Error | null = null;

    // Coerce to keyword if embeddings not available (#10)
    const effectiveMode: SearchMode =
      (!this.embeddingsAvailable && (this.activeMode === 'semantic' || this.activeMode === 'hybrid'))
        ? 'keyword'
        : this.activeMode;

    try {
      results = await this.client.search({
        query,
        mode: effectiveMode,
        collection: this.collectionSelect.value || undefined,
        noRerank: this.settings.noRerank || undefined,
        candidateLimit: this.settings.candidateLimit ?? undefined,
        minScore: this.settings.minScore ?? undefined,
      });
      this.plugin.modelLoaded = true;
    } catch (err) {
      searchError = err as Error;
      log.error('search failed:', searchError.message);
    }

    // If a newer search has started, discard these results
    if (gen !== this.searchGeneration) return;

    const ms = Date.now() - t0;
    this.resultsEl.empty();

    if (searchError) {
      this.statusLine.setText('');
      this.resultsEl.createEl('p', { cls: 'qmd-error', text: `Error: ${searchError.message}` });
      return;
    }

    if (!results || results.length === 0) {
      this.statusLine.setText('0 results');
      this.resultsEl.createEl('p', { cls: 'qmd-no-results', text: 'No results.' });
      return;
    }

    this.statusLine.setText(`${results.length} results · ${ms} ms`);

    // Record query and report to plugin for status bar
    this.plugin.addRecentQuery(query);
    this.plugin.reportSearchResult(results.length, ms);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const item = this.buildResultItem(result, i + 1);
      this.resultsEl.appendChild(item);
      this.resultItems.push(item);
    }
  }

  private buildResultItem(result: QmdResult, rank: number): HTMLElement {
    const item = document.createElement('div');
    item.className = 'qmd-result-item';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;

    // Rank badge
    const rankBadge = item.createEl('span', {
      cls: 'qmd-rank-badge',
      text: String(rank).padStart(2, '0'),
    });
    void rankBadge;

    // Main content
    const content = item.createDiv({ cls: 'qmd-result-content' });

    // Title + path row
    const titleRow = content.createDiv({ cls: 'qmd-result-title-row' });
    const title = result.title || path.basename(result.path);
    titleRow.createEl('span', { cls: 'qmd-result-title', text: title });
    titleRow.createEl('span', { cls: 'qmd-result-path', text: result.path });

    // Snippet
    if (result.snippet) {
      const snippetEl = content.createEl('p', { cls: 'qmd-result-snippet' });
      const hasMarkTags = /<mark>/i.test(result.snippet);
      if (hasMarkTags) {
        snippetEl.innerHTML = sanitizeSnippet(result.snippet);
      } else {
        snippetEl.setText(result.snippet);
      }
    }

    // Score row: percentage + bars + date
    const scoreRow = content.createDiv({ cls: 'qmd-result-score-row' });
    scoreRow.createEl('span', { cls: 'qmd-result-score-pct', text: `${Math.round(result.score * 100)}%` });
    scoreRow.appendChild(buildScoreBars(result.score));
    if (result.collection) {
      scoreRow.createEl('span', { cls: 'qmd-result-collection', text: result.collection });
    }

    // Click handlers
    const openDefault = async () => {
      await navigateToResult(this.app, result);
      this.close();
    };
    const openNewTab = async () => {
      const leaf = this.app.workspace.getLeaf('tab');
      const file =
        this.app.vault.getFileByPath(result.path) ??
        this.app.vault.getMarkdownFiles().find(
          (f) => f.path.endsWith('/' + result.path) || f.basename === result.path.replace(/\.md$/, ''),
        ) ??
        null;
      if (file) await leaf.openFile(file);
      this.close();
    };

    item.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) void openNewTab();
      else void openDefault();
    });
    item.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (e.metaKey || e.ctrlKey) void openNewTab();
        else void openDefault();
      }
    });
    item.addEventListener('qmd-open', () => void openDefault());
    item.addEventListener('qmd-open-new-tab', () => void openNewTab());

    return item;
  }

  onClose(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.contentEl.empty();
  }
}
