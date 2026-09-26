# SPEC: Mux Code — make it a working AgentMux harness, then close the gaps with current CLI agents

**Date:** 2026-09-26
**Status:** proposed
**Author:** Agent3
**Trigger:** Repo owner: *"research the latest best features muxcode is missing in a CLI agent, focus on features
not already replicated by the agentmux wrapper, or features that play in well. write a spec."*
**Code read:** `agentmuxai/muxcode` at `55219ff2e` (v0.2.0, `@agentmuxai/muxcode`, not yet on npm) and
`agentmuxai/agentmux` at `c17adfb58` (v0.57.6).
**Related:** #3 (rename + publish workflow); in agentmuxai/agentmux: `docs/specs/SPEC_PROVIDER_CLI_VERSION_UPGRADE_2026_09_06.md`,
`docs/specs/SPEC_PROVIDER_AWARE_STARTUP_INSTRUCTIONS_2026_08_24.md`, `docs/providers/PROVIDER_MODELS_EFFORT_SETTINGS_2026-06.md`.
**Paths:** `src/…`, `catalog.json` and `package.json` are in this repo. Everything else (`providers.rs`,
`claude-translator.ts`, `host_spawn.rs`, `agent_config.rs`, …) is in
[agentmuxai/agentmux](https://github.com/agentmuxai/agentmux).
**Tracking:** the work is filed as issues in this repo, grouped by phase (§8); the AgentMux-side changes (§7) are
filed in agentmuxai/agentmux.

---

## 0. Summary

Mux Code is AgentMux's first-party agent CLI: a TypeScript loop over a local GGUF model (llama-server) or a cloud
API, with MCP tools and Claude-compatible stream-json output. Two findings drive this spec:

1. **Inside AgentMux it does not work today** (§2). The prompt never reaches the model, the pane can't render its
   output, and the model has no way to read files or see command output. So the first work is a harness contract,
   not features.
2. **Its real niche is local models.** Every major CLI agent now does cloud models well (Claude Code, Codex, Gemini,
   Copilot, Qwen, Kimi, OpenCode, Crush, Goose, Cline, Amp). None of them manages llama-server itself, keeps a warm
   KV cache across one-shot turns, or sizes its tool set to a small context. Those are what Mux Code should be best
   at (§5).

Everything AgentMux already does around a harness (§3) stays in AgentMux. Mux Code gains only what a harness must do
itself, or what makes AgentMux's existing features light up.

Phases: **0** harness contract (§4) → **1** core agent loop (§5.1) → **2** local-model excellence (§5.2) →
**3** integration features (§6). §8 ranks everything.

## 1. What Mux Code is today

From source (paths in `agentmuxai/muxcode`):

| Area | Today |
|---|---|
| CLI | `run -p <text>` (else stdin), `-b local\|anthropic\|openai\|openai-compat`, `-m`, `--base-url`, `--mcp-config`, `--system`, `--resume`; `auth status\|login`; `model list\|pull\|rm\|du` (`src/cli.ts`) |
| Loop | Up to 40 model↔tool rounds, tools run one at a time; `stopReason` ignored, so a `max_tokens` cut-off counts as done (`src/loop.ts`) |
| System prompt | A fixed 4-line string, or `--system` replaces it; no cwd, OS, date, git state or instruction files |
| Backends | Non-streaming calls on all four. No prompt caching, no thinking/effort, `temperature: 0.1` hard-coded (rejected by OpenAI reasoning models), `max_tokens: 8192` fixed |
| Tools | **No built-in tools.** Everything comes from MCP (stdio only); no namespacing; MCP `isError` ignored; output never truncated |
| Output | `system/init`, whole-message `assistant` frames, a non-standard `{type:"tool"}` result frame, `result`; no `stream_event` deltas, no usage on frames, `cost_usd: 0` (`src/emit/stream-json.ts`) |
| Sessions | **`--resume` only reuses the id string.** Nothing is saved or reloaded |
| Context | No token counting, truncation or compaction |
| Permissions | None; every tool call runs |
| Local runtime | Downloads llama-server b9558, starts it **per process** (so per AgentMux turn), `--ctx-size` always 4096 (the model sidecar has no context size), no `--jinja`/`-ngl`; catalog of 5 older GGUFs without checksums |
| Tests | None (`npm test` points at jest, which isn't installed) |

## 2. Why it doesn't work in AgentMux today

AgentMux runs Mux Code as a one-shot-per-turn subprocess (`providers.rs` `MUX_CODE`, `blockcontroller/subprocess/`).
Three independent breaks:

1. **The prompt never reaches the model.** AgentMux runs `muxcode run -p --dangerously-skip-permissions [--resume
   <sid>]` and writes the prompt to stdin (`host_spawn.rs`, `argv.rs`). Mux Code's `-p` takes a value, so the
   *flag name* becomes the prompt and stdin is never read. With other permission modes the prompt becomes
   `--permission-mode`.
2. **The pane can't render it.** AgentMux's Claude translator (`claude-translator.ts`) shows assistant text from
   `stream_event` deltas, tool results from `user` frames with `tool_result`, and stats from `result.usage`. Mux Code
   sends none of these. Worse, its text-only `assistant` frame before a tool call has no `stop_reason:"tool_use"`,
   which the translator treats as the end of the turn.
3. **The model can't touch the code.** With no built-in tools, its only tools are AgentMux's App API over MCP. None
   of those reads a file, and `Shell` returns an id, not output. Meanwhile ~78 App API tool schemas (~15–20K
   tokens) exceed the 4K local context on their own.

Also: `--resume` restores nothing, so every turn starts from scratch; AgentMux's `CLAUDE.md` (soul, memory, Global
Memory, skills index) is never read, although `SPEC_PROVIDER_AWARE_STARTUP_INSTRUCTIONS_2026_08_24.md` says it is;
and the local model reloads every turn.

## 3. What AgentMux already does — don't rebuild it in Mux Code

| AgentMux feature | Needs from the harness |
|---|---|
| Per-turn process, message queue, cross-process lease, failure banner | Non-zero exit or `result.is_error` on failure |
| Transcript store, pane history, `GetAgentTranscript`, `ListConversations`, SearchHistory (AgentMux record) | Claude-shaped frames with `session_id` on each line |
| Agent-to-agent messages (jekt) and their signing | `.mcp.json` loaded (already works) |
| API keys from bound accounts | Reads `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (already does) |
| MCP config + the App API (panes, browser, memory, work queue, cron, fleet) | Reads `./.mcp.json` (already does) |
| Instructions/memory/skills files | Reads `CLAUDE.md` (+ `@imports`), `.claude/skills`, `.claude/commands` |
| `AskUserQuestion` panel, rate-limit indicator, context meter, cost footer | The matching frames (§4.3) |
| Live Bash streaming (`agentmux-bashwrap` PreToolUse hook), PreCompact signal | A Claude-compatible hook runner and a tool named `Bash` (§6.1) |
| Interrupt (Esc → SIGINT, then kill) | Flush the transcript on SIGINT (§4.4) |

So Mux Code needs **no** transcript viewer, message router, account system, memory store, MCP registry or approval
UI of its own.

## 4. Phase 0 — the harness contract (P0)

Everything here is required before any other feature matters. It makes Mux Code a well-behaved Claude-compatible
headless CLI, the contract AgentMux already implements for Claude Code.

### 4.1 Invocation

- `-p`/`--print` is a **boolean**: print mode. The prompt comes from a positional argument if given, else stdin
  (read to EOF). Keep `--prompt <text>` for scripts.
- Accept and honour `--dangerously-skip-permissions` and `--permission-mode <mode>` with Claude Code's mode names:
  `default` (alias `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` (§6.2 defines what
  each does; in Phase 0 all may behave as bypass except `plan`).
- Accept `--verbose` and `--include-partial-messages` for compatibility, but **emit deltas by default**: Claude
  Code only streams `stream_event` lines with `--include-partial-messages`, and AgentMux doesn't pass it to Mux Code.
- Accept `--model`, `--effort <low|medium|high|max>` (mapped per backend: Anthropic thinking budget, OpenAI
  `reasoning_effort`, llama-server `chat_template_kwargs`/`--reasoning-budget`), `--max-turns`,
  `--append-system-prompt`, `--output-format stream-json|json|text`, `--verbose`.
- Unknown flags from newer AgentMux versions should warn on stderr, not fail.

### 4.2 Config root

Read `MUXCODE_CONFIG_DIR` (AgentMux sets it; Mux Code ignores it today). Sessions, settings and caches live under it,
defaulting to `~/.mux`.

### 4.3 Output: Claude stream-json, exactly as AgentMux's translator reads it

One JSON object per line, each with `session_id`:

- `system/init` (session id, cwd, model, tools, `mcp_servers` status).
- `stream_event` wrapping `message_start` (`message.model`, `message.usage` incl. cache fields),
  `content_block_start` (text / thinking / tool_use id+name), `content_block_delta` (`text_delta`,
  `thinking_delta`, `input_json_delta`), `content_block_stop`, `message_delta` (`usage.output_tokens`,
  `stop_reason`). This needs **streaming backends** (§5.1).
- `assistant` frames with `message.id`, `model`, `stop_reason`, `usage`; a turn that continues with a tool call must
  carry `stop_reason:"tool_use"`.
- `user` frames: `{type:"user", message:{role:"user", content:[{type:"tool_result", tool_use_id, content,
  is_error}]}}`, optionally `tool_use_result{stdout, stderr, interrupted}` for Bash.
- `result` with `subtype` (`success` / `error_during_execution` / `error_max_turns`), `is_error`, `result`,
  `stop_reason`, `duration_ms`, `num_turns`, and `usage{input_tokens, cache_creation_input_tokens,
  cache_read_input_tokens, output_tokens}`. Cost goes in **both** `total_cost_usd` (Claude Code's field) and
  `cost_usd` (the field AgentMux's footer reads, `claude-translator.ts`), from a per-model price table; 0 for local.
- Optional: `rate_limit_event{retry_after_ms}` on 429s, `system/compact_boundary` with `compactMetadata{trigger,
  preTokens, postTokens}` (§5.1), and model-download progress as a `system` frame AgentMux can show (today's
  `system/loading` is dropped as unknown — agree a name with the AgentMux side).
- Drop the custom `{type:"tool"}` frame.

**Exit codes:** 0 success; 1 error; distinct codes for "max turns" and "interrupted" (130). Codex, Gemini, Qwen and
Kimi all do this; Gemini uses 53 for the turn limit and Kimi 75 for retryable failures — pick values and document
them.

### 4.4 Sessions that actually resume

- Persist each session as JSONL under `$MUXCODE_CONFIG_DIR/sessions/<id>.jsonl` (the message list after every
  model/tool step, plus metadata: model, backend, cwd, token totals).
- `--resume <id>` reloads the messages and appends the new prompt. `--continue` resumes the latest for the cwd.
- On SIGINT/SIGTERM: stop the current step, write the transcript, emit a `result` with `is_error`, close MCP servers,
  exit 130. (AgentMux hard-kills after SIGINT; the flush must be quick.)

### 4.5 Read AgentMux's instructions

Follow Claude Code's rules, since AgentMux writes for them: `~/.claude/CLAUDE.md`, then `CLAUDE.md` or
`.claude/CLAUDE.md` in each directory from the repo root down to the cwd, each followed by `CLAUDE.local.md`,
**concatenated** root-first, not overridden; `.claude/rules/*.md` (with optional `paths:` globs); `@path` imports
relative to the importing file, at most 4 levels deep (AgentMux writes `@.claude/AGENTMUX_MEMORY.md` when the user
owns `CLAUDE.md`). Send it as the first user message, as Claude Code does, so the system prompt stays cache-stable.

Also read `AGENTS.md`, now the cross-agent standard (Linux Foundation AAIF; Codex, Amp, Goose, Crush and Copilot
read it). Claude Code reads it only when no `CLAUDE.md` exists; since AgentMux always writes one, Mux Code should
read **both** (Claude's `claude-md-and-agents-md` setting). Cap the total (Codex: 32 KiB).

### 4.6 Acceptance

An AgentMux Mux Code agent, on a cloud backend: receives the prompt; streams text into the pane; shows each tool call
with its result; keeps context across three turns; shows tokens and cost; follows an instruction placed in
`CLAUDE.md`; interrupts cleanly. A test harness replays AgentMux's exact argv and stdin.

## 5. Phase 1 and 2 — the agent itself

### 5.1 Phase 1: the core loop every current agent has

| # | Feature | What good looks like (who does it best) |
|---|---|---|
| 1 | **Built-in file and shell tools, named like Claude's** | `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `TodoWrite` with Claude's parameter names (`file_path`, `old_string`, `new_string`, `replace_all`, `command`, `pattern`). AgentMux's rich renderers, progress checklist and Bash hook key on these exact names (`stream-parser.ts`). Qwen Code and Kimi Code converged on the same names in 2026 |
| 2 | **Tolerant edit matching** | Exact first, then progressively looser: trailing whitespace → leading/trailing → whitespace-normalized → indentation-flexible → Unicode punctuation folded to ASCII (Codex `seek_sequence.rs`); OpenCode chains 9 replacers from Cline and Gemini, with a guard against matches much larger than `old_string`. Unique match required unless `replace_all`. Keep CRLF and BOM. Gemini adds an LLM fixer as the last resort — optional |
| 3 | **`apply_patch` for OpenAI-family models** | Codex's Lark-grammar patch format (`*** Begin Patch` … `*** End Patch`). OpenCode and Copilot switch to it automatically for GPT models; they're trained on it |
| 4 | **Read-before-edit and stale-file guard** | Refuse to edit a file never read, or changed on disk since (Crush) |
| 5 | **Tool-output caps** | Head+tail truncation (Crush: 30K chars; Copilot spills >20 KiB), with the full output written to a file the model can `Read` (Goose, OpenCode). Critical for small contexts |
| 6 | **Streaming** | All backends stream (needed for §4.3 deltas). Local: llama-server supports streaming with partial tool-call arguments |
| 7 | **Real system prompt** | cwd, OS, shell, date, git branch/status/last commits (Crush), the tool guidance, then instruction files. Keep it **byte-stable** across turns (§5.2 caching) |
| 8 | **Prompt caching** | Anthropic `cache_control` on the system prompt, tools and the last messages (Crush, OpenCode); OpenAI `prompt_cache_key` = session id (Codex, OpenCode). Report cache tokens in `usage` |
| 9 | **Context accounting and compaction** | Track tokens per turn against the model's window; auto-compact at a threshold (Qwen/Kimi 0.85, Goose/Copilot 0.8) by summarizing older turns with the same model; keep recent turns and the todo list; prune old tool outputs first (OpenCode protects the last 40K of tool output). After compacting, re-inject the instruction files and re-read the few most recent files (Claude Code re-reads up to 5). Emit `compact_boundary` so AgentMux re-injects memory |
| 10 | **Honest stop reasons and retries** | Handle `max_tokens` (continue or report), backoff on 429/5xx with `rate_limit_event`, request timeouts, surface errors as `is_error` results |
| 11 | **Loop detection** | Stop when the same tool call + result repeats (Crush: 5 in 10 steps; Gemini: 5 identical in a row; OpenCode "doom loop": 3) |
| 12 | **MCP hygiene** | Namespace tools `mcp__<server>__<tool>` (Claude's form); honour `isError`; render image results as images; http/streamable transport; `${VAR}` expansion; per-server enable/disable lists |

### 5.2 Phase 2: local-model excellence (the differentiator)

None of the surveyed agents owns this end to end. Goose added built-in llama.cpp inference in 2026; Hermes Agent
manages llama.cpp; the rest point at an OpenAI-compatible URL and leave the server to the user.

| # | Feature | Detail |
|---|---|---|
| 1 | **Keep llama-server alive across turns** | AgentMux spawns Mux Code once per turn, so today every turn reloads the model. Run llama-server as a detached, reusable daemon keyed by model + settings (a lockfile + port under `$MUXCODE_CONFIG_DIR`), with an idle timeout. This is the single biggest local-latency win |
| 2 | **KV-cache reuse across turns** | Pin one slot per session (`id_slot`), keep `cache_prompt` on, and keep the prompt prefix byte-stable (llama.cpp's cache broke for Claude Code over a varying header; OpenCode's per-agent prompts force reprocessing). Use slot save/restore (`--slot-save-path`) to survive daemon restarts: a tester saw a 182 s first request drop to 4.7 s after restore. Hybrid/SWA models (gpt-oss, Gemma 4, Qwen 3.5/3.6) need `--ctx-checkpoints` tuning |
| 3 | **Right context size and flags** | Read the context length from GGUF metadata (not a missing sidecar field → 4096), cap by available VRAM, and start with `--jinja` (default on in current builds, but pin it), `-ngl` auto, `-fa auto`, `-np 1` (parallel slots split the context). Current llama.cpp supports all of these |
| 4 | **Robust tool calling on open weights** | llama.cpp's autoparser handles most templates, but 2026 issues show malformed calls (Qwen3-Coder XML packing, gpt-oss Harmony ~4% at temp 1.0). **Retry on parse failure** (re-sample once, then fall back), and a **text fallback parser** (Nanocoder: native → XML → JSON). Pass the parser's real error back to the model, not "tool does not exist" (Nanocoder bug #1300). For gpt-oss, send prior reasoning back on multi-turn tool calls |
| 5 | **Small tool set for small contexts** | The App API's ~78 tools can't fit a 4–32K window. Load only a core set by default (the built-ins + `SendMessage`, `Memory*`), and expose the rest through a search/load tool (Claude Code's deferred tools + `ToolSearch`, default since v2.1.7; Codex's MCP tool search, default since 0.143; Copilot has experimental retrieval). A "compact prompt" profile for ≤15B models (Cline's Compact Prompt, Nanocoder `/tune`) |
| 6 | **Speculative decoding** | `--spec-type ngram-mod` (`--spec-default`) — cheap, no draft model, good on code and repetitive edits; `draft-mtp` only for GGUFs that ship MTP tensors |
| 7 | **A current model catalog, with checksums** | Replace the 2024 models (Qwen2.5-Coder, DeepSeek-Coder-V2, Llama 3.1, Phi-4) with current open coding models that fit consumer GPUs (e.g. the Qwen 3.6/3.8 and Qwen3-Coder-Next families, Devstral Small 2, GLM-4.7-Flash, gpt-oss-20b — check licenses and verify tool-calling in our own test before listing). Add `sha256` (the downloader already verifies when present), context length and a recommended quant. Guidance from 2026 testing: dynamic Q4_K_XL/Q5_K_XL weights; KV cache q8_0 (safe for Qwen, not for Gemma 4); no sub-4-bit quants for tool calling |
| 8 | **Model routing** | A small/fast model for titles, compaction summaries and commit messages (Aider `--weak-model`, OpenCode `small_model`, Claude's Haiku slot); optionally local-for-cheap, cloud-for-hard |
| 9 | **Fix the platform assets** | Verify the llama-server release asset names per OS/GPU (the CUDA naming looks wrong for Windows and Linux), and use an authenticated or cached release lookup (unauthenticated GitHub API calls get rate-limited on first run) |

## 6. Phase 3 — features that play into AgentMux

### 6.1 Claude-compatible hooks

Hooks are now standard: Claude Code, Codex (12 events, stable since 0.124), Gemini, Qwen, Kimi, Copilot, Goose and
Cline all run them, most in Claude's format (exit code 2 blocks; JSON `permissionDecision`, `updatedInput`,
`additionalContext`). AgentMux writes `.claude/settings.json` with a `PreToolUse` Bash hook (`agentmux-bashwrap`,
live Bash streaming) and `PreCompact`. Running those two events, then `PostToolUse`, `UserPromptSubmit`, `Stop` and
`SessionStart`, makes AgentMux's hook-driven features work unchanged.

### 6.2 Permission modes and approvals

- Honour the modes AgentMux passes: `plan` (read-only tools, like Crush/Copilot/Gemini plan modes), `acceptEdits`,
  `bypassPermissions`, `default`.
- Allow/ask/deny rules in Claude's syntax from `.claude/settings.json` (`Bash(npm run *)`, `Edit(/src/**)`,
  `mcp__server__tool`), checked deny → ask → allow. Split shell operators (`&&`, `||`, `;`, `|`) so each part must
  match, and strip wrappers like `timeout`/`nice` first (Claude Code does both).
- A small built-in **destructive-command guard** that works even in bypass mode: `rm -rf` outside the workspace,
  `git push --force`, credential files. Keep it tight: Crush's first-word blocklist is easy to bypass with
  wrappers like `env` (see its report).
- Interactive approval prompts need **persistent mode** (§6.3): AgentMux's approval protocol is Claude's stdio
  control protocol (`control_request can_use_tool`), available only to persistent providers.

### 6.3 Persistent mode (stdin stream-json)

`--input-format stream-json` keeps one process alive for many turns (Claude Code, Qwen `--input-format`, Amp
`--stream-json-input`, Kimi's wire mode). For AgentMux this unlocks:
- **mid-turn steering:** agent-to-agent messages delivered during a turn instead of queued (Kimi `steer`,
  Codex `turn/steer`);
- **approval prompts** via the control protocol;
- a warm process: no MCP restart per turn, and the llama-server daemon (§5.2) matters less.

Needs AgentMux to set `persistent_launch_args` for Mux Code. Do it after Phase 1.

### 6.4 Skills, commands and AskUserQuestion

- Load `.claude/skills/*/SKILL.md` and `~/.agents/skills` with progressive disclosure: only name and description in
  the prompt, full body on demand (Codex caps the index at ~2% of context). AgentMux already writes these files.
- Expand `/name` from `.claude/commands/*.md` with `$ARGUMENTS`.
- An `AskUserQuestion` tool (`input.questions`): AgentMux's question panel already renders it.

### 6.5 Checkpoints and undo

A shadow git repo committed before each edit, with rewind of files, conversation or both (Gemini `/rewind`, Copilot
`/rewind`, OpenCode snapshots, Cline checkpoints; Claude Code's `/rewind` tracks only edit-tool changes, not files
changed through Bash). AgentMux has no undo of its own, so this is new value. Codex removed its ghost-snapshot undo
in 2026 — keep the design simple (commit per edit, rewind by commit), and say plainly what it doesn't cover.

### 6.6 Sub-agents

A `Task`/`Agent` tool that runs a child loop with its own context and returns a summary (every major agent has one).
For AgentMux's Swarm view it should write Claude's sub-agent JSONL layout, or AgentMux's watcher must learn Mux
Code's. Lower priority than §6.1–6.4.

### 6.7 Safety extras

- Redact known secret shapes from tool output before it reaches a cloud model (Codex `codex-secrets`, Copilot
  `--secret-env-vars`).
- Treat web and tool output as untrusted: tag it, and don't follow instructions inside it (Goose has
  prompt-injection scanning and an "adversary" reviewer model; Codex a "Guardian" reviewer). Optional.
- OS sandboxing (Codex: Seatbelt / bubblewrap / Windows restricted token; Gemini; Copilot preview) is valuable but
  large; defer, and rely on AgentMux's container runs for isolation meanwhile.

## 7. AgentMux-side changes

| Change | Where |
|---|---|
| Pin `@agentmuxai/muxcode` to the first published version (0.2.0 after agentmuxai/muxcode#3 publishes) | `providers.rs` `pinned_version`, `catalog.ts` |
| A Mux Code `models` list and `--model`/`--effort` wiring | `catalog.ts`, `buildRuntimeArgs.ts` |
| `persistent_launch_args` once §6.3 exists | `providers.rs` |
| Download-progress frame support | `claude-translator.ts` |
| Optional: extend the Claude-only gates (native memory reconcile, sub-agent watcher, native SearchHistory, Compact button) to Mux Code once it writes compatible layouts | `memory_reconcile.rs`, `subagent_watcher/`, `history/`, `AgentComposerStrip.tsx` |
| A container image for Mux Code, and `MUXCODE_CONFIG_DIR` on the container env denylist | `agent_handlers/input.rs`, `container.rs` |
| Fix stale docs: `providers.rs` says `run -p "<prompt>"`; `PROVIDER_MODELS_EFFORT_SETTINGS_2026-06.md` names `@a5af/muxcode`; the startup-instructions spec says Mux Code reads `CLAUDE.md` | those files |

## 8. Priority and sequencing

| Priority | Item | Size | Why |
|---|---|---|---|
| **P0** | §4.1 invocation, §4.3 stream-json, §4.4 sessions, §4.5 instructions | M | Nothing works in AgentMux without them |
| **P0** | §5.1 #1 built-in tools (Claude names) | M | The model can't read or run anything |
| **P0** | §5.1 #6 streaming | S–M | Required by §4.3 |
| P1 | §5.1 #2–5 tolerant edits, apply_patch, stale guard, output caps | M | Edit success rate; small contexts |
| P1 | §5.1 #7–10 system prompt, caching, compaction, retries | M | Cost, continuity, reliability |
| P1 | §5.2 #1–3 llama-server daemon, KV reuse, context/flags | M | Turns local from unusable to fast |
| P1 | §5.2 #4–5 tool-call robustness, small tool set | M | Local models actually calling tools |
| P1 | Tests: a replay harness for AgentMux's argv/stdin and frame shapes; edit-matcher unit tests | M | There are none |
| P2 | §6.1 hooks, §6.2 permission modes + guard | M | AgentMux features light up; safety |
| P2 | §5.2 #7 current model catalog, #9 platform assets | S–M | First-run success |
| P2 | §6.4 skills, commands, AskUserQuestion | S | AgentMux already writes the files |
| P2 | §5.1 #11–12 loop detection, MCP hygiene | S | Robustness |
| P3 | §6.3 persistent mode | L | Steering, approvals |
| P3 | §6.5 checkpoints/undo, §6.6 sub-agents, §5.2 #6 speculative decoding, #8 routing | M each | Nice to have |
| P3 | §6.7 redaction, injection defences, sandboxing | M–L | Defence in depth |

## 9. Open questions

1. **Keep Mux Code at all, or make "local" a mode of an existing harness?** `ollama launch` (Ollama ≥0.15) and
   llama-server's Anthropic `/v1/messages` endpoint let Claude Code, Codex and OpenCode run on local models today.
   Mux Code's case rests on §5.2: owning the llama-server lifecycle, KV reuse across one-shot turns and small-context
   tool sets, tuned for AgentMux. If that isn't the plan, pointing an existing harness at a local endpoint is cheaper.
2. Which open models to ship in the catalog, given licenses and our own tool-calling results (not vendor benchmarks).
3. Exit-code values (§4.3), and the name of the download-progress frame, agreed with the AgentMux side.
4. Whether persistent mode (§6.3) replaces the llama-server daemon (§5.2 #1) or complements it (it complements it
   for one-shot runs and scripts).

## 10. Sources

Research done 2026-09-25/26 from primary sources (vendor docs, source on `main`, release notes), with anything
unverified marked in the underlying reports:
- Claude Code docs (code.claude.com/docs); Codex (learn.chatgpt.com/docs, github.com/openai/codex:
  `apply_patch.lark`, `seek_sequence.rs`, `exec_events.rs`); GitHub Copilot CLI (docs.github.com/copilot,
  github.com/github/copilot-cli changelog); Gemini CLI (geminicli.com/docs); Qwen Code
  (qwenlm.github.io/qwen-code-docs); Kimi Code (moonshotai.github.io/kimi-code); OpenCode (opencode.ai/docs,
  github.com/anomalyco/opencode); Crush (github.com/charmbracelet/crush); Goose (goose-docs.ai,
  github.com/aaif-goose/goose); Aider (aider.chat); Cline (docs.cline.bot); Amp (ampcode.com/news); agents.md.
- llama.cpp: `tools/server/README.md`, `docs/autoparser.md`, `docs/speculative.md`, issues #20225, #24807, #26530,
  #27720, #29319, discussions #13606, #15396, #20574; Nanocoder issue #1300.
- AgentMux and Mux Code: the files cited inline.
