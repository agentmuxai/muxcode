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

## Develop

```sh
npm ci
npm run build
node bin/muxcode.js --help
```

Releases: bump `version` in `package.json`, merge, then push a matching tag (`v0.2.0`). The
[publish workflow](.github/workflows/publish.yml) builds and publishes to npm.

## License

MIT
