# AGENT.md

This file is the working guide for coding agents modifying BoxedAgent. Keep it up to date when architecture, workflows, or conventions change.

## Project Overview

BoxedAgent is a Node.js/TypeScript Docker-based agent + sandbox platform.

- A **Box** is an Ubuntu Docker sandbox with its own `/workspace` and independent pi coding-agent configuration.
- A **Session** is a pi RPC agent runtime bound to a Box, model settings, thinking settings, and cwd.
- The backend exposes REST + WebSocket APIs for Box/session/file/terminal/code-server/port-proxy management.
- The frontend is a React/Vite Web UI with desktop and mobile layouts.

## Repository Structure

```text
.
├── server/                  # Fastify backend, Docker + pi RPC orchestration
│   ├── src/
│   │   ├── agent/           # pi runtime/session/config/model probing logic
│   │   ├── config/          # env loading and path resolution
│   │   ├── core/            # shared server types, errors, persistent store
│   │   ├── docker/          # Dockerode integration and container file ops
│   │   ├── routes/          # REST routes: boxes, sessions, files, pi-config, code-server, ports
│   │   └── ws/              # WebSocket event hub and terminal bridge
│   └── package.json
├── web/                     # React + Vite frontend
│   ├── src/
│   │   ├── components/      # UI panels: Chat, Sidebar, Files, Terminal, Settings, etc.
│   │   ├── lib/             # API client, ids, composer events, shared frontend helpers
│   │   ├── state/           # Zustand app store
│   │   ├── App.tsx          # root layout, auth shell, desktop/mobile panel switching
│   │   └── styles.css       # global MD3/Claude-like dark UI styles
│   └── package.json
├── docker/box.Dockerfile    # default Ubuntu dev sandbox image
├── docker-compose.yml       # production-ish compose deployment
├── data/                    # local runtime state/workspaces; may contain secrets
├── package.json             # npm workspaces and root scripts
└── README.md                # user-facing documentation
```

## Important Runtime Paths

Inside each Box:

```text
/workspace                                      # Box workspace mount
/workspace/.upload                             # chat-uploaded attachment files
/workspace/.boxedagent/pi-agent/settings.json  # per-Box pi settings
/workspace/.boxedagent/pi-agent/models.json    # per-Box pi models
/workspace/.boxedagent/pi-agent/AGENTS.md      # per-Box agent instructions
/workspace/.pi/SYSTEM.md
/workspace/.pi/APPEND_SYSTEM.md
/workspace/.pi-sessions/*.jsonl                # pi session history
```

The backend starts pi with:

```text
PI_CODING_AGENT_DIR=/workspace/.boxedagent/pi-agent
```

## Development Commands

Use Node.js >= 22 and npm workspaces.

```bash
npm install
npm run typecheck
npm run build
npm run typecheck -w @boxedagent/server
npm run typecheck -w @boxedagent/web
npm run build -w @boxedagent/server
npm run build -w @boxedagent/web
```

Dev servers:

```bash
npm run dev:web   # Vite frontend, usually http://localhost:5173
npm start         # built backend, usually http://localhost:8080
npm run dev -w @boxedagent/server  # backend watch mode if needed
```

Default Box image:

```bash
npm run docker:build-box
```

## Service Management in This Workspace

Prefer tmux, not `nohup`.

```bash
tmux new-session -d -s boxedagent -n dev -c /mnt/datas/agent_workspace/BoxedAgent 'npm run dev:web'
tmux split-window -h -t boxedagent:dev -c /mnt/datas/agent_workspace/BoxedAgent 'npm start'
tmux attach -t boxedagent
```

Health checks:

```bash
curl -fsS http://127.0.0.1:5173 >/dev/null && echo vite-ok
curl -fsS http://127.0.0.1:8080/api/health >/dev/null && echo backend-ok
```

If Vite dev mode serves a stale/empty module, restart the frontend pane and `touch` the affected file(s), then hard-refresh the browser.

## Validation and Commit Policy

After implementing a change:

1. Run the narrowest relevant checks first.
2. Run broader checks before committing when the change affects shared behavior.
3. Commit tested changes.

Typical matrix:

```bash
# Frontend-only
npm run typecheck -w @boxedagent/web
npm run build -w @boxedagent/web

# Backend-only
npm run typecheck -w @boxedagent/server
npm run build -w @boxedagent/server

# Cross-cutting
npm run typecheck
npm run build
```

Commit style: concise imperative subject, for example:

```bash
git add <changed-files>
git commit -m "Improve file browser bookmarks and errors"
```

Do not commit generated secrets, local logs, throwaway test scripts, or workspace data.

## Security and Secret Handling

`data/state.json` and Box pi config may contain user-provided model/provider settings and API keys. Treat as sensitive.

- Do not print full `data/state.json` contents in responses.
- Do not echo API keys, auth tokens, cookies, or model secrets.
- `.env` is local; `.env.example` is safe template documentation.
- Production requires `BOXEDAGENT_TOKEN`; do not weaken auth checks.
- Bearer token and HttpOnly cookie auth are both supported.

## Backend Conventions

### Fastify Routes

- Keep route files under `server/src/routes/*` grouped by domain.
- Validate request params/query/body with `zod`.
- Use existing `badRequest`, `conflict`, `notFound` helpers from `server/src/core/errors.ts`.
- Keep public routes minimal. Protected areas include `/api/*`, `/ws/*`, `/codeserver/*` unless explicitly public in auth.

### Store and Types

- Server domain types live in `server/src/core/types.ts`.
- Keep persisted records backwards-compatible; normalize defaults in the store when adding fields.
- `data/state.json` is persistent app state and may contain secrets.

### Docker Integration

- Docker operations are centralized in `server/src/docker/docker-service.ts`.
- Always keep file operations inside `/workspace`; reject path traversal.
- Use Python snippets carefully for in-container file operations; return concise, user-friendly errors.
- Terminal/TUI streams must remain binary-safe:
  - demux Docker exec streams;
  - do not UTF-8 decode arbitrary chunks before forwarding to xterm.

### Agent Runtime

- pi RPC lifecycle is in `server/src/agent/agent-runtime.ts` and `agent-manager.ts`.
- Distinguish session states:
  - `running`: RPC runtime connected and idle.
  - `working`: model/tool/compact/prompt operation active or queued.
  - `stopped`/`error`: no usable runtime.
- Do not auto-start agent just to read historical messages.
- Fork/duplicate semantics:
  - `fork`: use pi RPC fork and create/rebind session appropriately.
  - `duplicate`: copy session config but not history.

## Frontend Conventions

### UI Style

- React + Vite + Zustand.
- Keep the polished dark MD3 / Claude-like visual style.
- Prefer custom MD3 menus over native selects for primary controls.
- Use icon buttons for compact toolbar actions, especially mobile.
- Tool/thinking cards should be concise; latest/current auto-expanded, older content collapsed where appropriate.
- Desktop sidebars are hideable/resizable; mobile shows one panel at a time via bottom nav.

### State

- Global app state lives in `web/src/state/app.ts`.
- API calls live in `web/src/lib/api.ts`.
- Cross-component composer insertion uses `web/src/lib/composer-events.ts`.
- Do not mutate Zustand arrays in place; return new arrays/objects.

### Chat and Attachments

Chat uploads go to `/workspace/.upload`.

`@file` semantics in Web should mimic pi TUI/CLI behavior:

- Only recognize file refs when `@` is preceded by whitespace.
- Text files are fetched and inlined as:

  ```xml
  <file name="/workspace/path.txt">
  ...
  </file>
  ```

- Images are sent as RPC image attachments and represented in prompt as:

  ```xml
  <file name="/workspace/image.png"></file>
  ```

- Missing/unreadable refs should remain plain text and should not block sending.
- Do not add hidden explanatory prompt sections for attachments.
- Avoid rendering base64 images inline by default; show lightweight attachment cards/icons and load previews only on click.

### Send Behavior

- Idle session: send directly with normal mode.
- Working + empty input: button acts as stop.
- Working + input/attachments: show send-mode menu.
- Immediate send while working should abort current turn then retry prompt.
- Steer/follow-up should use pi RPC streaming behavior and should not abort.

### File Browser

- Keep it VS Code-like: flat rows, lightweight icon toolbar, right-side three-dot menu.
- File operations include upload, mkdir, rename, copy, cut, paste, duplicate, delete, download/open, copy path, and attach to chat.
- Bookmarks are localStorage-backed and scoped by Box id.
- Switching Box should reset Files to `/workspace`.
- Nonexistent directories should show friendly messages and a return-to-workspace action.

## CSS Guidance

- Global styles live in `web/src/styles.css`.
- Mobile breakpoint is currently `780px`; desktop-specific visual changes should use `@media (min-width: 781px)` so mobile remains unaffected.
- Keep mobile bottom nav safe-area aware; avoid placing fixed overlays behind it.
- When changing borders, preserve mobile 1px feel unless explicitly requested.

## WebSocket Guidance

- Use `wsUrl()` from `web/src/lib/api.ts`.
- Clean up sockets with `closeWebSocketQuietly()` to avoid React StrictMode "closed before established" noise.
- Browser-side WebSocket event handlers should tolerate cleanup races and stale session ids.

## Code-server and Terminal Notes

- code-server is proxied through the backend and validates WebSocket Origin; preserve origin rewriting logic.
- In Vite dev mode, code-server URLs intentionally open backend `:8080` directly.
- Terminal uses xterm and binary WebSocket frames; avoid changes that reintroduce Docker multiplex headers or broken UTF-8 decoding.

## Pi Documentation

When working on pi-specific features, consult installed pi docs/source as needed. Relevant local docs may include:

```text
/home/wsdx233/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md
/home/wsdx233/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/docs
.cache/pi-mono/packages/coding-agent/src
```

Read relevant docs completely before changing pi integration behavior.
