const path = require('path') as typeof import('path');

import type { QmdResult } from '../client/types';

export function buildResultItem(result: QmdResult, onClick: () => void): HTMLElement {
  const item = document.createElement('div');
  item.className = 'qmd-result-item';
  item.setAttribute('role', 'button');
  item.tabIndex = 0;

  const header = item.createDiv({ cls: 'qmd-result-header' });

  const title = header.createEl('span', {
    cls: 'qmd-result-title',
    text: result.title || path.basename(result.path),
  });
  title.style.fontWeight = 'bold';

  if (result.collection) {
    header.createEl('span', {
      cls: 'qmd-result-badge',
      text: result.collection,
    });
  }

  header.createEl('span', {
    cls: 'qmd-result-score',
    text: `${Math.round(result.score * 100)}%`,
  });

  if (result.snippet) {
    item.createEl('p', {
      cls: 'qmd-result-snippet',
      text: result.snippet,
    });
  }

  item.createEl('span', {
    cls: 'qmd-result-path',
    text: result.path,
  });

  item.addEventListener('click', onClick);
  item.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') onClick();
  });

  return item;
}
