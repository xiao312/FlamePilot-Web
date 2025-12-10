# Repository Guidelines

## Project Structure & Module Organization
- Frontend React/Vite code in `src/` (components, contexts, hooks, utils, styles).
- Backend Express server in `server/` (routes, CLI bridge, session management, auth DB).
- Static assets in `public/`; build output in `dist/` (generated).
- Auth DB lives at `server/database/geminicliui_auth.db` (created on first run).
- Tests are minimal here; add in `tests/` or colocated as needed.

## Build, Test, and Development Commands
- `npm run dev` — run backend and frontend together (Vite dev server + Express).
- `npm run client` — start Vite frontend only.
- `npm run server` — start Express backend only.
- `npm run build` — build frontend to `dist/`.
- `npm run preview` — serve the built frontend for local preview.
- `npm run dev-mock` — dev mode with mocked CLI (uses `GEMINI_PATH=./bin/gemini`).

## Coding Style & Naming Conventions
- JS/JSX with ES modules; prefer functional components and hooks.
- Indentation: 2 spaces; keep code ASCII unless required.
- Follow existing patterns: Tailwind utility classes in JSX; context/hooks for shared state.
- Use descriptive component/prop names; keep files PascalCase for components.
- Linting via `eslint.config.js` (run `npx eslint .` if needed).

## Testing Guidelines
- No enforced framework present; prefer Jest/RTL for React, supertest for server.
- Name tests alongside source (`Component.test.jsx`) or under `tests/`.
- Include critical paths: auth, WebSocket flows, CLI bridge behaviors, file/Git ops.

## Commit & Pull Request Guidelines
- Write clear commits in present tense (e.g., `Add shell sandbox guard`, `Fix chat placeholder text`).
- For PRs: describe scope, testing performed, and any config/env changes; add screenshots for UI tweaks.
- Avoid formatting-only PRs; group related changes and keep diffs small when possible.
- When crafting commit messages, prefer the existing prefixes in this repo history (`feat:`, `fix:`, `chore:`). Summarize the primary change in a short imperative/present-tense phrase (e.g., `fix: harden per-user paths and shell streaming`). Keep it one line, focused on the most important behavior change.

## Security & Configuration Tips
- Copy `.env.example` to `.env`; set `PORT`, `VITE_PORT`, `JWT_SECRET`, optional `GEMINI_PATH`.
- Tools and shell access are sensitive—default to disabled/limited in production; consider sandboxing.
- WebSocket/API require JWT; first registered user becomes admin. Keep `geminicliui_auth.db` secure.
