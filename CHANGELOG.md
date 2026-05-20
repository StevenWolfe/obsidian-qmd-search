## [0.14.0](https://github.com/StevenWolfe/obsidian-qmd-search/compare/0.13.1...0.14.0) (2026-05-20)

### Features

* **docs:** add /changelog page rendered from CHANGELOG.md ([fbba291](https://github.com/StevenWolfe/obsidian-qmd-search/commit/fbba291cb715d11f4953376cf4325efeeb1b8359))
* **release:** suppress fix(ci)/fix(docs) releases, hide internal types from notes ([580d362](https://github.com/StevenWolfe/obsidian-qmd-search/commit/580d362307d58bcd695383b6b8a104957aa0dbf3))

## [0.13.1](https://github.com/StevenWolfe/obsidian-qmd-search/compare/0.13.0...0.13.1) (2026-05-20)


### Bug Fixes

* **ci:** restore missing version in actions/checkout@v6 for deploy-docs ([5a42222](https://github.com/StevenWolfe/obsidian-qmd-search/commit/5a422222fe8d5fce3a025279aa2338fae407f17e))

# [0.13.0](https://github.com/StevenWolfe/obsidian-qmd-search/compare/0.12.13...0.13.0) (2026-05-20)


### Features

* add local telemetry plumbing (opt-in, disabled by default, [#185](https://github.com/StevenWolfe/obsidian-qmd-search/issues/185)) ([8529df7](https://github.com/StevenWolfe/obsidian-qmd-search/commit/8529df7efe5278dbbad359b2c13b9ce47c0b4db2))
* diagnostics report + paste.rs share ([#185](https://github.com/StevenWolfe/obsidian-qmd-search/issues/185)) ([a5f7d62](https://github.com/StevenWolfe/obsidian-qmd-search/commit/a5f7d62c70f95a9620365fb22076f6ff42084261))

## [0.12.13](https://github.com/StevenWolfe/obsidian-qmd-search/compare/0.12.12...0.12.13) (2026-05-20)


### Bug Fixes

* **ci:** use GH_PAT for semantic-release to fix 403 on release creation ([579537e](https://github.com/StevenWolfe/obsidian-qmd-search/commit/579537e9e47002f091a7c174029b1de1439c0d0e))

## [0.12.12](https://github.com/StevenWolfe/obsidian-qmd-search/compare/0.12.11...0.12.12) (2026-05-20)


### Bug Fixes

* **lint:** resolve eslint-plugin-obsidianmd 0.3.0 errors ([8986294](https://github.com/StevenWolfe/obsidian-qmd-search/commit/898629451be5c3103174e475bf8819b812ba9607))

## [0.12.11](https://github.com/StevenWolfe/obsidian-qmd-search/compare/0.12.10...0.12.11) (2026-05-20)


### Bug Fixes

* **ci:** guard against automated-release-triggered loops in ship workflow\n\nSkip ship workflow early if last commit looks like an automated release bump (prevents repeated PR/merge loops).\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com> ([ed28172](https://github.com/StevenWolfe/obsidian-qmd-search/commit/ed2817245dee53e60fa1c3f26d1a09d4e64ef3d8))
* **settings:** eliminate status flash, fix macOS icons, show collection path ([24fcd7b](https://github.com/StevenWolfe/obsidian-qmd-search/commit/24fcd7b220eb7364a224652ba7bb5eb86f3ad872)), closes [#99](https://github.com/StevenWolfe/obsidian-qmd-search/issues/99)

# Changelog

All notable changes to QMD Search are documented here. Versions follow [Semantic Versioning](https://semver.org/). Release artifacts are on the [GitHub releases page](../../releases).

---

## [0.12.0] — 2026-05-19

### Fixed
- Settings panel auto-refreshes after Generate embeddings / Re-index completes — no manual navigate-away required
- Status bar chip shows a pulsing `embedding…` or `indexing…` indicator for the full duration of long operations; button disables and shows `⏳` to prevent double-triggering
- Status popover footer wraps when three buttons are too wide to fit; Settings button is right-aligned via `margin-left: auto`

### Changed
- Auto-reindex delay default corrected from 3 s → 90 s — 3 s was too aggressive for vaults with 500+ notes where `qmd update` takes 5–15 s; starting conservative until a self-tuning benchmark is available

---

## [0.11.0] — 2026-05-19

### Added
- `IndexHealth` discriminated union (`empty` / `partial` / `stale` / `healthy` / `building` / `error`) as the single source of truth for index state across all surfaces
- Status bar collapses to one chip — yellow dot + `N · no embeds` when embeddings are missing, resolving the conflicting broken-plug + green-dot indicator bug
- Search modal: Semantic and Hybrid mode buttons disable with tooltip when embeddings are missing; warn banner with inline Generate button; footer reads `keyword (BM25) — fallback`
- Status popover primary CTA adapts: `partial` → Generate embeddings, `healthy` → Re-index

### Changed
- Settings health card shows a yellow warning header `Index partial — embeddings missing` when `docs > 0` and `embeddings === 0`; primary CTA is Generate embeddings
- `Generate embeddings` label used consistently everywhere (`Embed` retired)
- qmd binary row: read-only chip with `Change…` edit-in-place; floating `resolved →` line removed
- Build hash stripped from settings header pill; full version with hash moved to Advanced › About
- Search modal anchors at `top: 15vh` (matches Quick Switcher), widens to `min(760px, 90vw)`
- Reindex delay default changed from 30 s to 3 s; range extended from 5–120 s to 1 s–5 min
- `candidateLimit` and `minScore` store `undefined` instead of `0`; placeholders read "Default (~40)" and "Default (disabled)"
- Plugin version rendered as plain muted text; green version pill removed
- Kebab `Remove` item gets a separator and `var(--text-error)` color

---

## [0.10.0] — 2026-05-18

### Fixed
- Onboarding shows on any new vault install, not only when qmd has zero collections globally
- Default collection dropdown uses live `qmd status` collections instead of `index.yml`

### Added
- Embed action surfaced in status popover, health card, and collection `⋯` menu

### Docs
- SQLite native addon ABI mismatch troubleshooting added to CLAUDE.md and README

---

## [0.9.0] — 2026-05-16

### Added
- Configurable reindex debounce delay (5–120 s slider, default 30 s)

### Docs
- README rewritten for v1 UX — status bar, popover, onboarding, search modal, settings
- Badges, Mermaid flow diagram, and design SVG diagrams added

### Chore
- Removed redundant `release.yml` (superseded by `ship.yml`)

---

## [0.8.0] — 2026-05-15

### Added
- `autoReindex` file watcher — debounced, respects the toggle setting
- `OnboardingModal` — 4-step checklist for binary / vault / index / hotkey setup
- `StatusPopover` — floating panel anchored above status bar, replaces StatusModal
- Redesigned `SearchModal` with toolbar, keyboard nav, score bars, debounce, snippet highlighting, and empty state with recent queries + suggestion chips
- Status bar with 5-state dot system; onboarding trigger; `recentQueries` persistence
- `PluginStatus` type and `recentQueries` / `onboardingDone` / `autoReindex` settings

### Changed
- Complete CSS rewrite — Obsidian CSS variables only (no hardcoded colours)
- `StatusModal` deleted; replaced by `StatusPopover`

---

## [0.7.0] — 2026-05-14

### Fixed
- Dropdown `onChange` values cast for TypeScript 6.0 contravariance

### Chore
- Bumped TypeScript to 6.0.3

---

## [0.6.0] — 2026-05-13

### Fixed
- Zip artifact and deploy path renamed to `obsidian-qmd-search`

### Chore
- Bumped `electron`, `@types/node`, `builtin-modules`

---

## [0.5.0] — 2026-05-12

### Chore
- Renamed plugin ID and all references from `qmd` to `obsidian-qmd-search`
- Added Dependabot; bumped `esbuild`, `electron`

---

## [0.4.1] — 2026-05-11

### Fixed
- `ship.yml` opens a PR for the version bump (main is PR-protected)
- `collectionSelectEl` declared as `| undefined` to satisfy tsc

### Added
- Re-index / Embed / Refresh buttons in the Status modal

---

## [0.4.0] — 2026-05-10

### Fixed
- Index name reverted to text field in Advanced — `qmd` has no index list command

---

## [0.3.0] — 2026-05-09

### Added
- Dropdowns for index / collection selection
- Index management section
- Status bar item

---

## [0.2.1] — 2026-05-08

### Added
- `--min-score` filter setting
- Collapsible Advanced settings section

---

## [0.2.0] — 2026-05-07

### Added
- `--no-rerank` toggle
- `-C` candidate limit setting

---

## [0.1.x] — 2026-04-27 to 2026-05-06

Initial implementation: CLI and MCP-HTTP transports, basic search modal, settings panel, collection management, `qmd status` parsing, PATH resolution for Electron renderer, esbuild bundling, GitHub Actions ship workflow.
