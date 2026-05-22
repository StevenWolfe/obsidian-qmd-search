import { App, MarkdownView, Notice, TFile } from 'obsidian';
import type { QmdResult } from '../client/types';

export async function navigateToResult(app: App, result: QmdResult): Promise<void> {
  // result.path is relative to the collection root (e.g. "notes/file.md").
  // Normalise separators and case for Linux (case-sensitive FS) before matching.
  const normalise = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  // qmd applies handelize() before storing paths: lowercases and replaces any run of
  // non-alphanumeric chars (spaces, parens, dots in dir names, etc.) with a single hyphen,
  // then strips leading/trailing hyphens per segment. We apply the same transform to vault
  // paths so we can match qmd-issued paths back to vault files.
  // Source: @tobilu/qmd dist/store.js `handelize()` (called on every file at index time).
  const handelize = (p: string) =>
    p.toLowerCase()
      .split('/')
      .map((seg, i, arr) => {
        if (i === arr.length - 1) {
          const dot = seg.lastIndexOf('.');
          const ext = dot > 0 ? seg.slice(dot) : '';
          const name = dot > 0 ? seg.slice(0, dot) : seg;
          return name.replace(/[^\p{L}\p{N}$]+/gu, '-').replace(/^-+|-+$/g, '') + ext;
        }
        return seg.replace(/[^\p{L}\p{N}$]+/gu, '-').replace(/^-+|-+$/g, '');
      })
      .filter(Boolean)
      .join('/');
  const pathNorm = normalise(result.path);
  const _absFile = app.vault.getAbstractFileByPath(result.path);
  const file =
    (_absFile instanceof TFile ? _absFile : null) ??
    app.vault.getMarkdownFiles().find((f) => {
      const fp = normalise(f.path);
      const fpH = handelize(f.path);
      const baseName = f.basename.toLowerCase();
      const qmdBase = pathNorm.replace(/\.md$/, '');
      return fp === pathNorm ||
        fpH === pathNorm ||
        fp.endsWith('/' + pathNorm) ||
        fpH.endsWith('/' + pathNorm) ||
        baseName === qmdBase ||
        handelize(baseName) === qmdBase;
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
