import { App, MarkdownView, Notice, TFile } from 'obsidian';
import type { QmdResult } from '../client/types';

export async function navigateToResult(app: App, result: QmdResult): Promise<void> {
  // result.path is relative to the collection root (e.g. "notes/file.md").
  // Normalise separators and case for Linux (case-sensitive FS) before matching.
  const normalise = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const slugify = (p: string) => p.replace(/ /g, '-');
  const pathNorm = normalise(result.path);
  const _absFile = app.vault.getAbstractFileByPath(result.path);
  const file =
    (_absFile instanceof TFile ? _absFile : null) ??
    app.vault.getMarkdownFiles().find((f) => {
      const fp = normalise(f.path);
      const fpSlug = slugify(fp);
      const baseName = f.basename.toLowerCase();
      const qmdBase = pathNorm.replace(/\.md$/, '');
      return fp === pathNorm ||
        fpSlug === pathNorm ||
        fp.endsWith('/' + pathNorm) ||
        fpSlug.endsWith('/' + pathNorm) ||
        baseName === qmdBase ||
        slugify(baseName) === qmdBase;
    }) ??
    null;

  if (!file) {
    new Notice(`QMD: File not found: ${result.path}`);
    return;
  }

  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);

  if (result.line == null) return;

  const view = leaf.view;
  if (view instanceof MarkdownView) {
    const editor = view.editor;
    const pos = { line: result.line, ch: 0 };
    editor.setCursor(pos);
    editor.scrollIntoView({ from: pos, to: pos }, true);
  }
}
