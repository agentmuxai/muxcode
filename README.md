# Mux Code

AgentMux's first-party agentic coding CLI. It runs a tool-using agent loop against a local GGUF model (via
llama-server) or a cloud API (Anthropic, OpenAI, or any OpenAI-compatible endpoint), with MCP tools.

Its output is Claude-compatible stream-json, so [AgentMux](https://agentmux.ai) runs it as a harness like Claude
Code: pick **Mux Code** when you create an agent, and AgentMux installs this package for you.

## Install

Requires Node.js 24.18.1 or later.

```sh
npm install -g @agentmuxai/muxcode
```

## Use

```sh
muxcode auth login                            # download a local model, or set up an API key
muxcode run -p "add a --dry-run flag to the deploy script"
muxcode run -p "..." -b anthropic -m <model>  # pick a backend and model
muxcode run -p "..." --resume <session-id>    # continue a previous session
```

`run` options:

| Option | What it does |
|---|---|
| `-p, --prompt <text>` | The task |
| `-b, --backend <name>` | `local`, `anthropic`, `openai` or `openai-compat` |
| `-m, --model <name>` | Model name, or a path to a local model |
| `--base-url <url>` | Endpoint for `openai-compat` |
| `--mcp-config <path>` | An `.mcp.json` with the MCP servers to load |
| `--system <text>` | Replace the system prompt |
| `--resume <session-id>` | Resume a previous session |

Without `-b`, Mux Code picks the first that applies: `anthropic` if `ANTHROPIC_API_KEY` is set, `openai` if
`OPENAI_API_KEY` is set, `openai-compat` if `OPENAI_BASE_URL` is set, and otherwise `local` (default model
`qwen2.5-coder:7b`, or `MUX_MODEL`).

Local models:

```sh
muxcode model list        # catalog and installed models
muxcode model pull <id>   # download one
muxcode model rm <name>
muxcode model du          # disk used by installed models
```

`muxcode auth status` exits 0 when any backend is ready.

## Tools

Built-in tools use Claude Code's names and parameters, so AgentMux renders them the same way:

| Tool | Parameters | Notes |
|---|---|---|
| `Read` | `file_path`, `offset`, `limit` | Text files, `cat -n` format, 2000 lines by default |
| `Write` | `file_path`, `content` | Creates parent directories |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` | Exact match; keeps CRLF line endings and a BOM |
| `Bash` | `command`, `timeout`, `description` | bash (`/bin/sh` if missing); on Windows Git Bash if found, else `cmd.exe`. Timeout 2 min (max 10) |
| `Grep` | `pattern`, `path`, `glob`, `type`, `output_mode`, `-i`, `-n`, `-A`/`-B`/`-C`, `head_limit`, `multiline` | ripgrep if `rg` is on `PATH`, else a built-in search |
| `Glob` | `pattern`, `path` | Newest first |
| `TodoWrite` | `todos` | The task checklist |

MCP tools from `.mcp.json` come after them; one with a built-in's name is ignored. With `--permission-mode plan`
only read-only tools are offered (`Read`, `Grep`, `Glob`, `TodoWrite`, and MCP tools marked read-only).

### Instruction files

Mux Code reads `CLAUDE.md` by Claude Code's rules, plus `AGENTS.md`, and sends them to the model as the first
user message (the system prompt stays unchanged, so it caches). Broadest first, all concatenated:

1. `~/.claude/CLAUDE.md`, then `~/.claude/rules/**/*.md`.
2. In each directory from the filesystem root down to the cwd, as Claude Code walks: `AGENTS.md`, `CLAUDE.md`,
   `.claude/CLAUDE.md`, `CLAUDE.local.md`. So an AgentMux agent in `~/.agentmux/agents/<agent>/` also gets
   `~/.agentmux/agents/CLAUDE.md`.
3. Rules come from the project only: `.claude/rules/**/*.md` in the nearest directory holding `.git`, or in the
   cwd if there is none, right after that directory's own files.

- `AGENTS.md` is read alongside `CLAUDE.md` (Claude Code reads it only when there is no `CLAUDE.md`).
- `@path` imports (relative to the importing file, absolute, or `~/...`) are replaced by that file's content,
  up to 4 levels deep. Left as written: imports in code spans or fences, of missing files, and of a file already
  included. An import from a directory's file must resolve inside that directory's tree or the project's (the
  git root, else the cwd); Claude Code asks before following other imports, and a one-shot run has no one to ask.
  Files in `~/.claude` may import from anywhere.
- Block HTML comments (`<!-- ... -->`) are removed, except in code fences.
- Rules whose frontmatter has `paths:` are skipped: Claude Code loads them only when a matching file is read.
- The total is capped at 32 KiB. The most specific files are kept: the first file that doesn't fit keeps its
  head, with a marker, and broader files are omitted and named.

Set `MUXCODE_DISABLE_INSTRUCTIONS=1` to send none.

## Develop

```sh
npm ci
npm run build
node bin/muxcode.js --help
```

Releases: bump `version` in `package.json`, merge, then push a matching tag (`v0.2.0`). The
[publish workflow](.github/workflows/publish.yml) builds and publishes to npm.

## Design docs

Specs and the roadmap live in [`docs/`](docs/README.md). Work is tracked as issues in this repo.

## License

MIT
