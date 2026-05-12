# Manex Brain

A local AI brain for your Obsidian vault. Indexes all your notes and answers questions privately using a local Apple Silicon MLX model — no cloud, no API keys, no data leaves your machine.

## Requirements

- **macOS with Apple Silicon** (M1 or later)
- **Python 3** (via Homebrew: `brew install python`)
- **Obsidian 1.5.0** or later

## How It Works

On first load, the plugin:

1. Creates a Python virtual environment at `~/.obsidian-study-room/venv`
2. Installs [mlx-lm](https://github.com/ml-explore/mlx-lm) into the venv (~2 min on first run)
3. Downloads and starts `mlx-community/Qwen3-4B-4bit` (~2.3 GB, downloaded once)
4. Indexes all your vault notes in the background for vault-wide semantic search

After that, the server starts automatically every time Obsidian opens.

## Features

- **Fully local** — inference runs on-device via Apple's MLX framework; nothing is sent to the cloud
- **Vault-wide RAG** — all notes are indexed; relevant chunks are automatically included in every answer
- **Active note context** — the currently open note is semantically embedded and prioritised
- **Graph-aware** — linked notes, backlinks, and shared-tag notes are included as context
- **Clickable sources** — note links in answers open the corresponding note in Obsidian
- **Chat memory** — conversation history is maintained within a session
- **Automatic re-indexing** — notes are re-indexed on create, edit, rename, or delete

## Usage

1. Open Obsidian — the MLX server starts automatically in the background
2. Click the brain icon in the ribbon, or run **Open Manex Brain panel** from the command palette
3. Open any note and start asking questions — the plugin automatically uses it as context
4. Click any note link in an answer to open that note

## Commands

| Command | Description |
|---|---|
| Open Manex Brain panel | Opens the chat sidebar |
| Open Manex Brain web app | Opens manex.app |
| Ask Study Room about current note | Focuses the panel on the current note |

## Settings

| Setting | Description |
|---|---|
| Include frontmatter | Whether to include YAML frontmatter when reading notes |

## Privacy

All processing is local. The plugin:
- Makes no network requests except to `http://localhost:8080` (the local MLX server)
- Stores the vault index at `~/.obsidian-study-room/vault-index.json` (text only, no embeddings)
- Does not collect, transmit, or store any user data

## Troubleshooting

**"MLX server not available"** — The model may still be downloading or loading. Wait 2–5 minutes on first run; the panel will update automatically once the server is ready.

**Python not found** — Install Python via Homebrew: `brew install python`

**Slow first response** — Normal. The model (~2.3 GB) is downloaded and loaded into memory once; subsequent responses are fast.

## Support

Visit [manex.app](https://manex.app) to learn more or support development.
