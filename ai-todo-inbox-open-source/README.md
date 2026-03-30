# AI Todo Inbox

Local-first AI inbox for plans and notes.

You type into one input box. The app stores raw text locally first, then uses an OpenAI-compatible model to:

- classify content into `plan` or `note`
- merge related content into the same topic
- summarize note topics
- keep original text available for later review

## Stack

- React + TypeScript + Vite
- Mantine UI
- IndexedDB via Dexie
- Tauri 2 desktop client
- OpenAI-compatible chat completions API

## Features

- Local-first storage
- One unified inbox input
- Manual type override: auto / plan / note
- AI topic grouping and summary updates
- Desktop reminders
- Windows tray startup behavior
- Runtime-editable model settings

## Quick Start

```bash
pnpm install
pnpm dev
```

## Desktop Development

```bash
pnpm tauri:dev
```

## Desktop Build

```bash
pnpm tauri:build
```

## Environment Variables

Create `.env.local` from `.env.example`.

Example:

```bash
VITE_AI_BASE_URL=/api/ai
VITE_AI_MODEL=your-model-name
VITE_AI_API_KEY=
AI_PROXY_TARGET=https://your-openai-compatible-endpoint.example/v1
AI_PROXY_API_KEY=
```

Notes:

- In browser development, `/api/ai` can proxy requests to avoid CORS issues.
- In the desktop client, use a full API base URL plus API key.
- If AI config is missing, the app still works with local fallback rules.

## Project Structure

- `src/`: React app
- `src/lib/`: AI, storage, reminders, runtime helpers
- `src-tauri/`: desktop shell and native commands
- `public/`: static assets

## Open Source Notes

- This directory is sanitized for public release.
- Build output, local caches, personal environment files, and private API configuration are intentionally excluded.
