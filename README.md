# QMD Search — Obsidian Plugin

Search your [`qmd`](https://github.com/tobi/qmd)-indexed knowledge bases from inside Obsidian — BM25 keyword, vector semantic, and LLM-reranked hybrid search, all running locally.

> **Desktop only.** Requires the `qmd` CLI and a configured collection.

---

## Prerequisites

1. Install `qmd`:
   ```bash
   npm install -g @tobilu/qmd
   ```
2. Index at least one collection:
   ```bash
   qmd collection add ~/path/to/notes --name my-notes
   qmd embed
   ```
   Or let the plugin walk you through it — see [Onboarding](#onboarding) below.

---

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. Copy them to `<vault>/.obsidian/plugins/obsidian-qmd-search/`.
3. Settings → Community plugins → enable **QMD Search**.

### BRAT (beta testing)

Install [BRAT](https://obsidian.md/plugins?id=obsidian42-brat), then add this repository URL to track releases directly from GitHub.

---

## Status bar

The `qmd` indicator in the status bar shows index health at a glance. The dot changes color and label to reflect the current state:

| State | Dot | Label | Click |
|-------|-----|-------|-------|
| Idle | green | doc count | Open status popover |
| Empty | yellow | `no index` | Open onboarding (or settings) |
| Indexing | blue pulse | `indexing N / M` | Open status popover |
| Error | red | `binary not found` / `error` | Open settings |
| Transient | green | `N results · Xms` | Re-open search modal |

### Status popover

Clicking the status bar in **idle** or **indexing** state opens a floating popover with collection stats, doc counts, embedding counts, and last-indexed timestamp. Re-index and Open settings actions are available in the footer. Dismiss with a click outside or `Esc`.

---

## Onboarding

On first load (or when no collections are indexed), the plugin shows a 4-step checklist:

1. **Binary detected** — confirms `qmd` is on your PATH or configured path
2. **Vault registered** — register the current vault as a `qmd` collection
3. **Build index** — run `qmd update` + `qmd embed` to populate the index
4. **Bind hotkey** — open Settings → Hotkeys and assign the Search command

Each step auto-completes as soon as the condition is met. Skip sets `onboardingDone` and dismisses permanently.

---

## Search

Open the search modal with the **QMD: Search** command (`Ctrl/Cmd+P` → "QMD: Search"), or assign a hotkey in Settings → Hotkeys.

### Modes

| Mode | How it works |
|------|-------------|
| **Keyword** | BM25 full-text — fast, exact-term matching |
| **Semantic** | Vector similarity — finds conceptually related passages |
| **Hybrid** | Both combined with LLM reranking — best results, slower on first run while models load |

### Keyboard navigation

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move between results |
| `Enter` | Open result in current pane |
| `⌘Enter` / `Ctrl+Enter` | Open result in new tab |
| `Esc` | Close modal |

Results show a **score bar** (5-segment, proportional to relevance) and a highlighted snippet. The toolbar shows result count and query latency.

When no query is entered, the modal shows your **recent queries** for quick replay.

---

## Commands

| Command | Description |
|---------|-------------|
| **QMD: Search** | Open the search modal |
| **QMD: Re-index collections** | Run `qmd update` to refresh the index |
| **QMD: Generate embeddings** | Run `qmd embed` to (re)generate vectors |

---

## Settings

### Health panel

The settings tab renders differently depending on index state:

- **First run** — a setup card with a **Register this vault** button that runs `qmd collection add <vault> --name <name>` and `qmd embed`.
- **Healthy** — a stats panel (docs · collections · embeddings · last indexed) and a collections table. Each collection row has a `⋯` menu with Rename, Re-index, and Remove.

### Options

| Setting | Default | Description |
|---------|---------|-------------|
| `qmd binary path` | `qmd` | Full path to the `qmd` executable if not on PATH |
| `Transport mode` | CLI | **CLI** spawns a subprocess per query. **MCP HTTP** keeps a persistent daemon (faster after warm-up). |
| `MCP daemon port` | `8181` | Port for the MCP HTTP daemon |
| `Default collection` | *(all)* | Pre-selects a collection in the search modal |
| `Default search mode` | Hybrid | Mode the modal opens with |
| `Auto-reindex` | off | Re-indexes automatically 30 s after a markdown file is created, modified, or deleted |
| `Log level` | error | Console verbosity: `off` · `error` · `warn` · `debug` |

---

## How it works

The plugin communicates with `qmd` via one of two transports:

- **CLI mode** — spawns `qmd search|vsearch|query --json` per query. No daemon needed. First hybrid query may be slow while GGUF models load.
- **MCP HTTP mode** — connects to `qmd mcp --http` on `localhost:{port}`. The plugin manages daemon start/stop, reusing an existing process if one is running.

Results are normalised from `qmd`'s `qmd://collection/path` URI format into file paths, then matched against the vault for in-editor navigation.

---

## Troubleshooting

**`binary not found` in status bar** — Obsidian's Electron process has a stripped PATH. Set the full binary path in settings (e.g. `/home/you/.npm-global/bin/qmd`). The plugin also probes `~/.nvm/versions/node/*/bin`, `~/.local/bin`, `~/.npm-global/bin`, and `/usr/local/bin` automatically.

**No results** — Run `qmd status` in a terminal to verify the index is healthy. Run `qmd update` or use the Re-index command if files are stale.

**MCP daemon fails to start** — Switch to CLI mode, or run `qmd mcp --http` in a terminal to see error output.

---

## Development

```bash
git clone https://github.com/StevenWolfe/obsidian-qmd-search
cd obsidian-qmd-search
npm install
npm run build        # → main.js
npx tsc --noEmit     # type-check only
VAULT_PATH=~/path/to/vault npm run deploy
```

See [CLAUDE.md](CLAUDE.md) for architecture details.

To cut a release: use the **Ship Release** workflow dispatch on GitHub (patch / minor / major). It bumps versions, builds, commits, tags, and publishes automatically.

---

## License

MIT — see [LICENSE](LICENSE).
