# FlamePilot Web Architecture (Summary)

## Overview
- React + Vite front-end that mirrors FlamePilot CLI workflows: chat, shell, file/Git browsing, and editor.
- Node.js + Express back-end that bridges the UI to FlamePilot CLI, file system, and Git, with JWT auth and WebSocket streaming.
- Data lives locally: SQLite for auth, project/session JSON/JSONL managed in `~/.gemini/projects` and `~/.gemini/sessions` (legacy paths kept for compatibility).

## Frontend (src/)
- `App.jsx` wraps routes with Auth/Theme context, WebSocket hook, sidebar + main content layout, mobile nav.
- Core panels: `ChatInterface` (chat, tools, file refs, diff display), `Shell` (xterm terminal), `FileTree`, `EditorTab`/`CodeEditor`, `Sidebar` (project/session browser + settings).
- Contexts: `AuthContext` (JWT/token), `ThemeContext` (light/dark), `SettingsContext` (tools/local prefs).
- Hooks/Utils: `useWebSocket` for streaming chat/project updates/shell IO, `api.js` for REST calls, `notificationSound`, `useVersionCheck`.
- Styling: Tailwind (via `@tailwindcss/vite`) + custom `index.css`, Lucide icons, xterm/Monaco/CodeMirror for terminal/editor.

## Backend (server/)
- Entry: `server/index.js` (Express + WebSocket server) with JWT middleware, static dist serving, and CLI bridge wiring.
- Routes: `/api/auth` (login/register/status), `/api/git` (status/diff/commit/branches/pull/push), `/api/mcp`, `/api/config`.
- CLI bridge: `gemini-cli.js` spawns FlamePilot CLI processes; streams stdout/stderr over WebSocket; manages aborts.
- Projects/Sessions: `projects.js` lists projects from `~/.gemini/projects`; `sessionManager.js` keeps chat history cache and builds context windows.
- Auth DB: `database/db.js` initializes SQLite (`server/database/geminicliui_auth.db`) with bcrypt + JWT.
- File ops: read/write/list via `fs.promises` guarded by project root; watcher (`chokidar`) pushes `projects_updated` events to clients.
- Shell: `Shell.jsx` talks to a PTY via WebSocket; PTY created with `node-pty` in the selected project directory.

## Real-time & Messaging
- WebSocket server handles chat streaming, shell IO, and project refresh events.
- Client `useWebSocket` routes messages to chat UI, project list, and shell; includes reconnection and session mapping.

## Git & Files
- Git endpoints call `git` via `child_process.exec` scoped to the project path.
- File explorer/editor use REST for list/read/write, enforcing project-root boundaries.

## Configuration
- `.env` → `PORT` (backend, default 4008), `VITE_PORT` (frontend, default 4009), `JWT_SECRET`, optional `GEMINI_PATH` (FlamePilot CLI path), Photon dev flags.
- Vite proxies `/api` and `/ws` to backend during dev.

## Security Notes
- JWT protects API and WebSocket; first user becomes admin.
- Tools and potentially dangerous operations are opt-in via UI settings; shell runs in project cwd (consider sandboxing for multi-tenant deployments).
