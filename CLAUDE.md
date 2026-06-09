# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is an npm workspaces monorepo (Node.js >=20.6.0, ES modules) for **Inno Agent**, a personal learning agent built on the PI SDK.

- `apps/inno-agent/` — backend (CLI + HTTP server), TypeScript, compiles to `dist/`.
- `apps/inno-agent/web/` — frontend (React 19 + Lit + Tailwind 4 + Vite), workspace `inno-agent-web`.
- `electron/` — Electron main process (`main.js` + `loading.html`) for desktop builds.
- `runtime/` — local runtime state (config, data, skills); gitignored. Mapped to `INNO_*` env vars.
- `workspace/` — default agent working directory; gitignored.

PI SDK packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-web-ui`) are pulled from npm.

There is no top-level lint or test runner wired up. `vitest` is a dev dependency but no test scripts or test files exist — the TypeScript build (`npm run build`) serves as the sanity check.

## Common Commands

All commands are run from the repo root and use `npm --workspace` under the hood.

```bash
# Build backend + web
npm run build

# Start HTTP server (serves API + web/dist on port 3000)
npm run server -- --home ./runtime --workspace ./workspace --port 3000

# Start CLI (terminal agent, no HTTP)
npm run start -- --home ./runtime --workspace ./workspace

# Dev: run server and Vite dev separately
npm run dev:server      # backend on :3000
npm run web:dev         # Vite on :5173, proxies /api -> :3000
```

### Dev restart rules

- Changes to `src/server.ts` or backend API → `npm run build` + restart server.
- Changes to `web/vite.config.ts` → restart Vite.
- Changes under `web/src/` → Vite HMR usually handles it.
- If upload/Wiki/proxy behavior misbehaves, fully restart both. Health checks: `curl localhost:3000/health`, `curl localhost:5173/api/wiki/pages`.

### restart-dev.sh

The `restart-dev.sh` script at the repo root orchestrates the full dev lifecycle: `build`, `start`, `stop`, `status`, `logs`, `smoke`. Supports `--mode dev|prod` and `--skip-build`. Run `bash restart-dev.sh --help` for details. Useful for resetting to a clean state when things go wrong.

### Electron desktop builds

```bash
npm run electron              # Run desktop app locally
npm run electron:build        # Package macOS DMG (arm64)
npm run electron:build:win    # Package Windows NSIS + MSI (x64)
```

`electron/main.js` spawns the Node server as a child process (`ELECTRON_RUN_AS_NODE=1`), shows a loading window while polling `/health`, then opens the main window. First launch creates a default config at `~/.inno-agent/config/config.json`.

### CI/CD

GitHub Actions workflows (`.github/workflows/`):
- `release-mac.yml` — macOS Electron DMG builds on ARM64, triggered by `v*.*.*` tags or workflow_dispatch.
- `release-win.yml` — Windows NSIS + MSI builds on x64, same trigger.

## Runtime Path Resolution

Both `cli.ts` and `server.ts` bootstrap through `apps/inno-agent/src/runtime.ts`. This is the single source of truth for where data lives.

Precedence: CLI flag → env var → `~/.inno-agent/...`.

| CLI flag | Env var | Default |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config` | `INNO_CONFIG_FILE` | `<configDir>/config.json` |
| `--config-dir` | `INNO_CONFIG_DIR` | `<home>/config` |
| `--data` / `--data-dir` | `INNO_DATA_DIR` | `<home>/data` |
| `--skills` / `--skills-dir` | `INNO_SKILLS_DIR` | `<home>/skills` |
| `--workspace` / `--workspace-dir` | `INNO_WORKSPACE_DIR` | invocation CWD |
| `--port` | `INNO_PORT` (via config) | `3000` |

Derived paths inside `dataDir`: `learner/`, `sessions/`, `jobs/`, `l2/`, `channels/`. `applyRuntimeEnvironment` re-exports the resolved paths back into `process.env` plus `PI_CODING_AGENT_SESSION_DIR` so PI SDK code picks them up.

When editing path-related code, change `runtime.ts` rather than hard-coding paths in `cli.ts`/`server.ts`.

## Architecture

### Agent core (PI SDK + Inno extension)

The agent loop is provided by `@earendil-works/pi-coding-agent` (npm). Inno wraps it with an extension factory in `apps/inno-agent/src/agent/inno-extension.ts`, which:

1. Registers model providers from `config.json` via `pi.registerProvider` (e.g. an InnoSpark Anthropic-compatible endpoint).
2. Registers six tool groups: **learner tools** (L1), **scheduler tools**, **L2 wiki tools**, **L3 recall tools**, **practice lab tools**, **document tools**.
3. Hooks `before_agent_start` to prepend `INNO_SYSTEM_PROMPT` + an L1 context pack (profile + recent events) + threshold-gated L3 recall to the system prompt for every turn.
4. Hooks `session_start` to install custom TUI header/title.
5. Persists `model_select` events back to `config.json`.

`cli.ts` calls PI's `main(...)` with this extension and forces `--no-skills --skill <skillsDir>` so only the project's skills directory is loaded.

`server.ts` (HTTP) goes through `agent/pi-runner.ts`, which is a server-side facade around PI session APIs (`initSession`, `createNewSession`, `runPromptStreaming`, `completePromptOnce`, `switchModel`, etc.) and is shared by REST + SSE endpoints.

### Memory system

Three layers, all file-backed under `dataDir`:

- **L1 learner profile** (`src/memory/learner/`): evidence-driven profile + event log. `profile-store.ts` persists learner state; `profile-updater.ts`/`auto-profile.ts` mutate the profile from tool calls. Summarized into a `ContextPack` injected each turn. The learner can inspect and edit their profile directly.
- **L2 wiki memory** (`src/memory/l2/`): a structured wiki with `manifest-store.ts`, `raw-store.ts`, `wiki-maintainer.ts` (parses frontmatter), `wiki-linker.ts`, `wiki-query.ts`, plus a `summarizer.ts`, `source-converter.ts`, and `document-parser.ts` (handles PDF, Office documents, images). Exposed both to the agent (as tools) and to the web UI via `/api/wiki/*` (pages list, page CRUD, graph, stats).
- **L3 cross-conversation recall** (`src/memory/l3/`): indexes PI session JSONL files into SQLite (`node:sqlite`) with FTS5 full-text search for lexical retrieval. `sqlite-store.ts` manages the schema (chunks + embeddings tables). `indexer.ts` extracts messages from session files. `recall.ts` performs threshold-gated retrieval (`l3_recall` tool). Degrades gracefully on Node <22.5 (where `node:sqlite` is unavailable) — L3 recall is simply disabled.

### Scheduler

`src/scheduler/` implements cron-driven background jobs. `JobStore` persists `jobs.json` and appends `runs.jsonl` per execution. `CronScheduler` (uses `cron-parser`) triggers `job-runner.executeJob`. Jobs can also be invoked manually via `/api/jobs/:id/run` or from the agent itself via the `run_scheduled_job` tool. On boot, `normalizePersistedJobs` backfills `nextRunAt`/`lastStatus`/`runCount` fields, and `migrateReminderChannels` repoints legacy `push_reminder` jobs to the registered default Feishu target.

### Channels

`src/channels/` defines a `ChannelRegistry` and registers channels when their respective config blocks are present:

- **Feishu** (`feishu/feishu-channel.ts`): native Lark/Feishu integration via `@larksuiteoapi/node-sdk`.
- **QQ** and **WeChat** (`bridge/bridge-channel.ts`): bridge/sidecar mode — the agent communicates with an external sidecar process over HTTP, which handles the actual IM protocol. Each has a `sidecarBaseUrl` in config.
- `personal-dispatcher.ts` pushes reminders and messages back out through registered channels.

### HTTP server (`src/server.ts`)

Plain Node `http.createServer` (no framework). Key endpoints:
- `POST /api/chat/stream` — SSE streaming chat.
- `POST /api/chat` — non-streaming chat (full response).
- `GET/PUT /api/wiki/*` — wiki CRUD, graph, stats.
- `GET/POST/PATCH/DELETE /api/jobs[/:id]` — job management; `POST /api/jobs/:id/run` for manual execution.
- `GET /api/sessions` / `GET /api/sessions/:id` — session listing.
- `POST /api/skills/upload` — accepts `<skill-name>.zip`, unpacks into `skillsDir/<name>/` via `spawnSync('unzip', ...)`.
- `GET /health` — health check (polled by Electron loading screen).
- WebSocket upgrade for `/api/terminal` — xterm.js in-browser terminal.

Static frontend is served from `paths.webDistDir = apps/inno-agent/web/dist` when present. Skills are loaded from `paths.skillsDir` (defaults to `<home>/skills` but can be pointed at `.inno/skills/` for project-local skills).

### Terminal / Practice Lab (`src/terminal/`)

In-browser terminal (xterm.js over WebSocket) scoped to a workspace. `terminal-session-manager.ts` manages PTY sessions via `node-pty` (`local-pty-backend.ts`). `run-record-store.ts` persists run records that the agent can read (via practice tools in `agent/practice-tools.ts`), enabling the agent to observe command outputs in the Practice Lab.

### Workspace management (`src/workspace/`)

`workspace-registry.ts` manages multiple workspace directories. Each workspace has a `WorkspaceMeta` record (id, name, path, temp flag) persisted in `workspaces.json`. Sessions are bound to workspaces. The default workspace is the invocation CWD. Temp workspaces are auto-created for one-off tasks and cleaned up later.

### Document tools (`agent/document-tools.ts`)

Handles file uploads, workspace file reading, and document preview (CSV, Office formats). Uses `@llamaindex/liteparse` for document parsing. Works alongside the L2 wiki's `document-parser.ts` for ingestion into the knowledge base.

### Subagents (`pi-subagents`)

Optional subagent support via `pi-subagents` package, configured with `subagents.enabled` in `config.json`. When enabled, the agent can spawn sub-agents for parallel or isolated tasks.

### Web UI

Hybrid React + Lit. Mounts in `web/src/main.tsx` → `react/App.tsx`. State lives in framework-agnostic `stores/` (small `EventEmitter`-based stores: `chat-store`, `sessions-store`, `wiki-store`, `jobs-store`, `skills-store`, `settings-store`, `workspace-store`, `graph-store`, `app-store`). REST/SSE calls go through `web/src/api/`. Some legacy Lit components remain under `components/`. Tailwind 4 via `@tailwindcss/vite`.

**i18n**: The UI supports Chinese (`zh-CN`, default) and English (`en`), managed by `i18next` + `react-i18next` in `web/src/i18n/`. Locale is persisted to `localStorage` under `inno.locale`.

## Configuration

Runtime config lives at `<configDir>/config.json` (template: `config.example.json` at repo root). It declares `defaultProvider`, `defaultModel`, a `providers` map (each with `baseUrl`, `api` ∈ {`openai-completions`, `anthropic-messages`}, `apiKey`, `models[]`), optional `server.port`, optional `channels.feishu` / `channels.qq` / `channels.wechat` blocks, optional `bridge.token` (for bridge-mode channels), and optional `subagents.enabled`. The server hot-rewrites this file when the user switches model via the UI.

Model config supports `reasoning` (boolean), `contextWindow`, and `maxTokens` per model entry.
