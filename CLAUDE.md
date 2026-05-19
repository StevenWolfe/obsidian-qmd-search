# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`obsidian-qmd-search` — a desktop-only Obsidian community plugin that lets users search `tobi/qmd`-indexed knowledge bases from inside Obsidian. Uses BM25, vector, and LLM-reranked hybrid search provided by the external `qmd` CLI (`npm install -g @tobilu/qmd`).

## Commands

```bash
npm install          # install deps (js-yaml, esbuild, typescript, obsidian types)
npm run build        # production bundle → main.js
npm run dev          # watch mode for development
npx tsc --noEmit     # type-check only (no test suite yet)
VAULT_PATH=~/path/to/vault npm run deploy  # copy main.js + manifest.json + styles.css into vault
```

## Architecture

### Transport abstraction

All `qmd` interaction is behind a `QmdClient` interface (`src/client/base.ts`). The plugin instantiates one of two concrete implementations based on the `transportMode` setting, and swaps the instance if settings change.

- **`CliQmdClient`** (`src/client/cli.ts`) — uses `execFile` (not `spawn`) per query. Buffers full stdout before JSON parsing. Mode→command mapping: `keyword`→`search`, `semantic`→`vsearch`, `hybrid`→`query`. Strips ANSI escape sequences from error messages (qmd emits cursor-hide/show codes when it thinks it's in a TTY). `qmd status` has no `--json` flag; its plain-text output is parsed by `parseStatusText()`. `dispose()` is a no-op. Supports optional `--index <name>` (from `indexName` setting), `--no-rerank`, `-C <n>`, and `--min-score <f>` flags via `SearchOptions`.
- **`McpQmdClient`** (`src/client/mcp.ts`) — uses Node's `http` module (not `fetch`) to send JSON-RPC 2.0 POSTs to `http://localhost:{port}/mcp`. On `init()`, checks `~/.cache/qmd/mcp.pid`; if alive reuses it, otherwise spawns `qmd mcp --http` and TCP-polls until port accepts connections (15 s timeout via `waitForEndpoint`). Performs an MCP `initialize` handshake to obtain a session ID, which is sent as `mcp-session-id` header on all subsequent calls. On `dispose()`, kills the daemon only if this instance spawned it. Passes `no_rerank`, `candidates`, and `min_score` fields in the RPC payload when set.

### Key data flows

1. User opens SearchModal → types query → presses Enter
2. `SearchModal` fires `client.search(opts)` and an inline vault fuzzy-search in parallel
3. Vault results (Obsidian `prepareFuzzySearch`) render immediately; qmd results replace the loading state when the promise resolves
4. Clicking a result calls `navigateToResult(app, result)` (`src/util/navigate.ts`) which opens the file and scrolls to the line

### Result normalisation

`qmd --json` returns a bare array of `RawQmdResult` where the file field is a URI like `qmd://collection-name/relative/path.md`. `normalizeResult()` in `src/client/types.ts` splits this into `collection` and `path` fields used throughout the UI.

### Settings (`src/settings.ts`)

`QmdSearchSettings` is persisted via Obsidian's `loadData/saveData`. `saveSettings(rebuildClient)` accepts a boolean to skip client teardown for non-transport changes (e.g. default collection, search flags).

`QmdSettingTab.display()` renders two tiers:
- **Always visible**: binary path (+ Auto-detect button), default collection, default search mode, register vault, open index config, status.
- **Collapsible `<details>` Advanced section**: index name (`--index`), transport mode, MCP port (conditional), skip reranking (`--no-rerank`), reranker candidate limit (`-C`), minimum score (`--min-score`), log level.

The open/closed state of the Advanced section is read from the existing DOM before `containerEl.empty()` and re-applied after, so transport mode changes don't collapse it.

`SearchOptions` (`src/client/types.ts`) carries: `query`, `mode`, `collection`, `intent`, `limit`, `noRerank`, `candidateLimit`, `minScore`.

### Node built-ins

All Node builtins (`child_process`, `fs`, `os`, `path`, `http`, `net`) are loaded via `require(...)` (CJS), not ESM `import`, because esbuild marks them as external. They are type-cast via `as typeof import(...)` for TypeScript. `electron` is also external — the settings tab accesses `require('electron').shell` for `openPath`.

### PATH resolution (`src/util/env.ts`)

Electron's renderer process strips the user's shell PATH. Two functions work together:

- **`initShellContext(hint)`** — called once at plugin load (and on binary path changes). Spawns the user's login shell (`$SHELL -l -c '...'`) with a combined command that (a) runs `command -v qmd` to resolve the binary path and (b) prints the full environment after an `===ENV===` marker. Parses the output to populate `_shellEnv` (module-level cache) and return the resolved binary path. Falls back to a filesystem scan over `buildEnv()`'s PATH if the shell invocation fails. Exported as `resolveQmdBinary` for backward compatibility.
- **`buildEnv()`** — builds the env object passed to all `execFile`/`spawn` calls. Uses `_shellEnv` as the base when available (so conda, virtualenv, pyenv, NVM variables are all present), otherwise falls back to `process.env`. Augments PATH with Homebrew (`/opt/homebrew/bin`), Volta (`~/.volta/bin`), fnm (`$FNM_MULTISHELL_PATH`), NVM-managed node dirs, `~/.local/bin`, `~/.npm-global/bin`, MacPorts, and standard system paths.

### Collection name discovery

`src/util/config.ts` reads and parses `~/.config/qmd/index.yml` using `js-yaml`. Handles both array-of-objects and object-keyed YAML shapes, returning `string[]` and falling back to `[]` on any error.

### Logging

`src/util/log.ts` exports a `log` object (`log.error`, `log.warn`, `log.debug`) gated by a `LogLevel` setting (`off` | `error` | `warn` | `debug`). Default level is `error`. `setLogLevel()` is called from `loadSettings` and `saveSettings`.

### Releases

One workflow handles releases:

- **`ship.yml`** (`workflow_dispatch`) — the only release path. Go to GitHub → Actions → Ship Release → Run workflow → pick `patch` / `minor` / `major`. Bumps `manifest.json` and `versions.json`, commits, tags, and publishes the GitHub release in one run.

`release.yml` was deleted (PR #51) — it was a duplicate that would have fired a second time on the same tag.

---

## Known gotchas

### SQLite native addon ABI mismatch

`qmd` uses `better-sqlite3` (a compiled native Node.js addon) and `sqlite-vec` (a native SQLite extension). Neither ships prebuilds — both are compiled at `npm install` time against the Node.js ABI (NODE_MODULE_VERSION) in effect on the machine at that moment.

**How it breaks:** `qmd` runs as a subprocess spawned by the plugin via `execFile`. The host shell PATH (resolved by `initShellContext`/`buildEnv`) determines which `node` binary runs the `qmd` script. If the user later updates Node.js (via nvm, system package manager, asdf, etc.), the previously compiled `.node` file is now an ABI mismatch. `qmd` will fail with an error like:

```
Error: The module '.../better_sqlite3.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION X. This version requires NODE_MODULE_VERSION Y.
```

This error is swallowed by the plugin's `execFile` error handler and surfaces as "qmd not found" or a silent empty result.

**Fix:** Rebuild or reinstall qmd after any Node.js version change:

```bash
npm install -g @tobilu/qmd   # reinstall (recompiles native addons against current Node)
# or if the version is already correct:
npm rebuild -g better-sqlite3
```

**Electron note:** Obsidian is an Electron app, but `qmd` runs outside Electron's process — it uses the host Node runtime, not Electron's bundled one. If someone were to ever load `better-sqlite3` directly inside the plugin (not as a subprocess), they would need to compile it against Electron's Node ABI using `electron-rebuild`. Currently the plugin does not do this.

**nvm users:** The most common trigger is switching nvm default versions. Pin the Node version used at install time or rebuild after switching:

```bash
nvm use <version-used-to-install-qmd>
npm install -g @tobilu/qmd
```
