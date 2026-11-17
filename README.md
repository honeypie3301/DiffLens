# DiffLens

A high-throughput, virtualized code and text diff viewer built for large inputs, clean visual inspection, and optional AI change summaries.

## Features

- **No Size Limits & High-Throughput Virtualization**: Diff computation runs off the main thread in a dedicated Web Worker (`diff`), while the viewport virtualizes only visible rows with CSS containment and cached syntax tokens so multi-megabyte files scroll smoothly.
- **Split & Unified Views**: Inspect changes side-by-side with optional synchronized scrolling and a single unified minimap scrollbar, or switch to unified inline diffing.
- **Intraline Granularity & Folding**: Highlight word-level or character-level edits, ignore whitespace or case, fold unchanged context blocks, search across diffs, and step directly between change hunks (`Alt+Up` / `Alt+Down`).
- **Syntax Highlighting**: Auto-detects or manually selects highlighting across TypeScript, JavaScript, Python, Java, Rust, Go, C/C++, C#, JSON, YAML, SQL, HTML, CSS, Bash, and Markdown.
- **Relaxing Theme System**: Includes five built-in themes (`Midnight Mist`, `Sage & Moss`, `Twilight Lavender`, `Golden Luxe`, `Warm Alabaster`) and persistent font sizing, density, and viewer preferences.
- **Share, Export & History**: Share diffs via compressed URL hash links, download `.patch` files, and store recent snapshots locally in `localStorage`.
- **Optional AI Diff Summary**: Summarizes hunks (`Concise`, `Detailed`, `Risks`) with automatic large-patch chunking via `/api/explain`, or lets you copy the pre-formatted hunk prompt anywhere.

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite, `lucide-react`, `highlight.js`, `diff` (Web Worker)
- **Serverless / Node Backend**: Express (`server.ts`) & Vercel Web API route (`/api/explain.ts`) powered by `@google/genai` with optional OpenAI-compatible server fallbacks

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Diffing, highlighting, sharing, and `.patch` export work 100% locally without any API keys.

To enable the `/api/explain` AI summary locally, configure `GEMINI_API_KEY` in `.env` (or any optional server fallback key listed in `.env.example`).

## Deployment

### Vercel (Full-Stack with `/api/explain` AI)

1. Import the repository into Vercel (uses `vercel.json` automatically).
2. Add `GEMINI_API_KEY` (and/or optional fallback keys such as `GPT_OSS_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, or `OPENROUTER_API_KEY`) in **Project Settings > Environment Variables**.
3. Deploy — both the frontend and `/api/explain` serverless endpoint work out of the box with zero key entry by visitors.

### GitHub Pages (Static Hosting)

GitHub Pages deploys automatically via `.github/workflows/deploy.yml` (`npm run build:static`).

Because GitHub Pages only serves static files (no backend server):
- All diffing, syntax highlighting, theme switching, sharing, and `.patch` exports run client-side.
- Clicking **Explain** on a pure static site detects the missing `/api/explain` route (and tries Chrome's built-in `LanguageModel` if enabled, or offers **Copy Hunk Prompt**).
- To connect GitHub Pages to a live AI backend, deploy the same repo on Vercel and add a GitHub **Repository Variable** (`Settings > Secrets and variables > Actions > Variables`) named `VITE_API_BASE_URL` set to your Vercel URL (e.g. `https://your-app.vercel.app`), then re-run the Pages workflow.
