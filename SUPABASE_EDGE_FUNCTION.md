# Supabase Edge Function (public) for Craft AI

Goal: keep `GEMINI_API_KEY` **out of GitHub / browser**, and let GitHub Pages call your API safely with a shared quota.

## 1) Create the quota SQL

In Supabase Dashboard → **SQL Editor**, run:

- `supabase/migrations/20260108000100_craft_ai_quota.sql`

## 2) Create the Edge Function

Name it: `craft-ai`

Deploy with **JWT verification disabled** (public site needs it):

```bash
supabase functions deploy craft-ai --no-verify-jwt
```

## 3) Set secrets (server-side only)

```bash
supabase secrets set \
  GEMINI_API_KEY="AIza..." \
  CRAFT_SERVICE_ROLE_KEY="<service_role_key>" \
  ALLOWED_ORIGINS="https://<your>.github.io,http://localhost:5173" \
  GEMINI_ALLOWED_MODELS="gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash" \
  GEMINI_MARKCRAFT_MODELS="gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash" \
  GEMINI_FLASHCRAFT_MODELS="gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash" \
  GEMINI_MODEL_LIMITS_JSON='{"gemini-2.5-flash":{"rpd":20,"rpm":5},"gemini-2.5-flash-lite":{"rpd":20,"rpm":10},"gemini-3-flash":{"rpd":20,"rpm":5}}'
```

Note: Supabase CLI will refuse setting secrets that start with `SUPABASE_`. `SUPABASE_URL` is already available inside Edge Functions automatically; use `CRAFT_SERVICE_ROLE_KEY` for the service role key.

Optional: add a global cap across ALL models (extra safety):

```bash
supabase secrets set SITE_TOTAL_RPD_LIMIT=200 SITE_TOTAL_RPM_LIMIT=30
```

## 4) Point GitHub Pages to your API

Your function base URL looks like:

`https://<project-ref>.functions.supabase.co/functions/v1/craft-ai`

If you use the same Supabase project as the current HTML files (`jkhboywafpdesmdguvts`), the pages already default to:

`https://jkhboywafpdesmdguvts.functions.supabase.co/functions/v1/craft-ai`

Open your site with:

`.../markcraft.html?apiBase=https://<project-ref>.functions.supabase.co/functions/v1/craft-ai`

or set once in console:

```js
localStorage.setItem('craft_api_base','https://<project-ref>.functions.supabase.co/functions/v1/craft-ai')
```

## Endpoints

The edge function handles:

- `POST /api/gemini` (MarkCraft)
- `POST /api/flashcraft/generate_deck` (FlashCraft auto-generate deck)
