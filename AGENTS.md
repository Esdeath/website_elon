# Repository Guidelines

## Project Structure & Module Organization

This Astro/TypeScript static site serves the Chinese Elon Musk archive with Pagefind search.

- `src/pages/` defines routes for videos, Chinese transcripts, categories, books, and machine-readable endpoints.
- `src/components/`, `src/layouts/`, and `src/styles/` contain shared UI; `src/scripts/` contains browser interactions.
- `src/lib/` holds content, formatting, and SEO helpers. `src/content.config.ts` defines the content schema.
- `src/content/videos/*.json` is the source for bilingual records and independent Chinese articles. `src/data/books/` stores book content.
- `scripts/` contains ingestion, translation, validation, and build checks; `scripts/fixtures/` contains parsing fixtures.
- `tests/e2e/` contains browser tests; `public/` holds fonts, icons, and hosting headers. `dist/` is generated output.

## Build, Test, and Development Commands

Use Node.js 22 or newer. Run `npm install` and copy `.env.example` to `.env` for local configuration.

- `npm run dev`: start the Astro development server.
- `npm run build`: validate content, run unit tests and Astro checks, build pages, index search, and verify search/SEO output.
- `npm run preview`: serve the production build locally.
- `npm test` / `npm run test:watch`: run Vitest once or continuously.
- `npm run test:e2e`: run Playwright against desktop Chrome and a 390px mobile viewport; Chrome must be installed.
- `npm run validate`: check content integrity and configuration.
- `npm run sync`: fetch, translate, and review content; requires an authenticated local Codex CLI.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, semicolons, and strict TypeScript. Follow neighboring code; no dedicated formatter or linter is configured. Use PascalCase for Astro components, kebab-case for utility files and content slugs, and camelCase for functions. Reuse existing CSS variables.

## Testing Guidelines

Name unit tests `*.test.ts` beside related library or script code; use `*.spec.ts` under `tests/e2e/`. No numeric coverage threshold is configured. Cover changed behavior and content integrity. Verify desktop/mobile layouts and keyboard interactions for UI changes. Run `npm run build` for code or content changes; production search requires the generated Pagefind index.

## Commit & Pull Request Guidelines

Follow existing scoped Conventional Commits: `feat(scope): ...`, `fix(scope): ...`, and `chore(scope): ...`. Keep commits focused and preserve unrelated working-tree changes. PRs should describe behavior, validation, relevant issues, and screenshots for visible changes.

## Content & Configuration

Preserve source URLs, segment IDs, and translation provenance. Derive Chinese articles from existing records; never invent missing text. Set `PUBLIC_SITE_URL` and `PUBLIC_CONTACT_EMAIL` for production. Keep credentials and generated artifacts untracked; translation credentials belong only on local machines.
