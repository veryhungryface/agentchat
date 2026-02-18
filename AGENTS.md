# Repository Guidelines

## Project Structure & Module Organization
This repository is a full-stack chat app:
- `src/`: React frontend (entry: `src/main.jsx`, root UI: `src/App.jsx`).
- `src/components/`: UI units such as chat messages, task panel, and search panels.
- `src/utils/`: frontend helpers (for example favicon utilities).
- `public/`: static assets served by Vite.
- `server.js`: Express backend with SSE streaming and search/model orchestration.
- `.agents/skills/`: local agent skill definitions used by this project.

## Build, Test, and Development Commands
- `npm install`: install dependencies for local development.
- `npm run dev`: start Vite frontend dev server.
- `npm run server`: run backend API (`server.js`) on `PORT` (default `3001`).
- `npm run dev:all`: run frontend and backend together via `concurrently`.
- `npm run build`: create production frontend build in `dist/`.
- `npm run preview`: preview built frontend locally.
- `npm run lint`: run ESLint across the repo.

Production backend deploy flow in `README.md` uses `npm ci --omit=dev` and PM2.

## Coding Style & Naming Conventions
- Language/tooling: ESM JavaScript + React JSX.
- Follow ESLint config in `eslint.config.js`; keep code lint-clean before PR.
- Use 2-space indentation and single quotes to match existing code.
- Components/files: `PascalCase` for React components (for example `ChatMessage.jsx`).
- Variables/functions: `camelCase`; constants: `UPPER_SNAKE_CASE`.
- Keep styling in `src/*.css` and component behavior in `.jsx`.

## Testing Guidelines
No automated test framework is configured yet. For now:
- Run `npm run lint` as a required quality gate.
- Smoke-test key flows manually with `npm run dev:all`.
- For backend checks, use the `curl` example in `README.md` against `/api/search`.
- If adding tests, colocate as `*.test.jsx` near source files.

## Commit & Pull Request Guidelines
- Prefer Conventional Commit prefixes seen in history: `feat:`, `fix:`, `docs:`, `chore:`.
- Keep commits focused and descriptive; avoid vague messages.
- PRs should include:
  - What changed and why.
  - How it was verified (`npm run lint`, manual chat/search checks).
  - Screenshots or short recordings for UI changes.
  - Related issue links when applicable.

## Security & Configuration Tips
- Never commit `.env` or secrets (`.gitignore` already excludes them).
- Configure API keys via environment variables only.
- Do not run `npm run dev` in production; run backend with a process manager (PM2).
