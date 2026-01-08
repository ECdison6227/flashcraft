# FlashCraft-Prod dev server (static + Gemini proxy)

This folder contains a tiny Python server that:

- Serves the static HTML files (same as `python3 -m http.server`, but with extra API routes)
- Proxies Gemini requests so the **Gemini API key stays on the server side**
- Applies a **shared global quota** (all visitors share the same limits)

## Start (local)

```bash
cd FlashCraft-Prod
export GEMINI_API_KEY="AIza..."
export GEMINI_ALLOWED_MODELS="gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash,gemma-3-1b,gemma-3-2b,gemma-3-4b"
# Rotate models to "pool" per-model free quotas (shared by all visitors)
export GEMINI_MARKCRAFT_MODELS="gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash"
export GEMINI_FLASHCRAFT_MODELS="gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash"
# Optional: add a global hard cap (across ALL models) to prevent runaway abuse
export SITE_TOTAL_RPD_LIMIT=0
export SITE_TOTAL_RPM_LIMIT=0
# Optional: override per-model limits (RPD/RPM) if your console shows different numbers
export GEMINI_MODEL_LIMITS_JSON='{"gemini-2.5-flash":{"rpd":20,"rpm":5},"gemini-2.5-flash-lite":{"rpd":20,"rpm":10},"gemini-3-flash":{"rpd":20,"rpm":5}}'
python3 dev_server.py
```

Deploy tip (public hosting):

```bash
export HOST=0.0.0.0
export PORT=8080
```

Open:

- `http://localhost:5173/markcraft.html`
- `http://localhost:5173/flashcraft2.0.html`

## Using a different API host (GitHub Pages)

Both MarkCraft and FlashCraft can point to a different API origin:

- URL param: `?apiBase=https://your-api-host`
- or set once in console: `localStorage.setItem('craft_api_base','https://your-api-host')`

This is useful when your static pages are on GitHub Pages and your API proxy runs elsewhere.

## API

- `POST /api/gemini` (MarkCraft uses this by default)
- `POST /api/flashcraft/generate_deck` (FlashCraft "AI 自动生成词书" uses this)

## Notes

- Do **not** commit `GEMINI_API_KEY` to GitHub.
- If you deploy this publicly, keep the quota low (Gemini free tier can be small) and monitor abuse.
