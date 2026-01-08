/// <reference types="jsr:@supabase/functions-js/edge-runtime.d.ts" />

import { createClient } from "jsr:@supabase/supabase-js@2";

type RateLimitResult = {
  ok: boolean;
  retry_after: number;
  day_used: number;
  minute_used: number;
};

const corsHeaders = (origin: string | null) => {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0 ? "*" : (origin && allowed.includes(origin) ? origin : allowed[0] ?? "null");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

const splitCsv = (v: string | null) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

const defaultModelLimits = (model: string): { rpd: number; rpm: number } => {
  if (model === "gemini-2.5-flash") return { rpd: 20, rpm: 5 };
  if (model === "gemini-2.5-flash-lite") return { rpd: 20, rpm: 10 };
  if (model === "gemini-3-flash") return { rpd: 20, rpm: 5 };
  if (model.startsWith("gemma-3-")) return { rpd: 14400, rpm: 30 };
  return { rpd: 20, rpm: 5 };
};

const parseModelLimits = (): Record<string, { rpd: number; rpm: number }> => {
  const raw = (Deno.env.get("GEMINI_MODEL_LIMITS_JSON") || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, { rpd: number; rpm: number }> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k !== "string" || !v || typeof v !== "object") continue;
      const vv = v as Record<string, unknown>;
      const rpd = Number(vv.rpd);
      const rpm = Number(vv.rpm);
      if (!Number.isFinite(rpd) || !Number.isFinite(rpm)) continue;
      out[k] = { rpd: Math.max(0, Math.floor(rpd)), rpm: Math.max(0, Math.floor(rpm)) };
    }
    return out;
  } catch {
    return {};
  }
};

const extractTextFromGemini = (payload: any): string => {
  try {
    return String(payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
  } catch {
    return "";
  }
};

const extractJsonObject = (text: string): Record<string, unknown> | null => {
  const t = (text || "").trim();
  if (!t) return null;
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      return JSON.parse(t);
    } catch {
      // fallthrough
    }
  }
  const start = t.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const chunk = t.slice(start, i + 1);
        try {
          return JSON.parse(chunk);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

const supabaseAdmin = () => {
  // Supabase Edge Functions automatically provide SUPABASE_URL.
  // Supabase CLI blocks secrets starting with SUPABASE_, so we use a custom name for service role.
  const url = (Deno.env.get("SUPABASE_URL") || Deno.env.get("CRAFT_SUPABASE_URL") || "").trim();
  const key = (Deno.env.get("CRAFT_SERVICE_ROLE_KEY") || Deno.env.get("CRAFT_SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL (auto) or CRAFT_SERVICE_ROLE_KEY (secret).");
  }
  return createClient(url, key, { auth: { persistSession: false } });
};

const consume = async (scope: string, rpd: number, rpm: number): Promise<RateLimitResult> => {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("craft_ai_try_consume", {
    p_scope: scope,
    p_rpd: rpd,
    p_rpm: rpm,
  }).single();
  if (error) throw new Error(error.message);
  return data as RateLimitResult;
};

const consumePair = async (
  scopeA: string,
  rpdA: number,
  rpmA: number,
  scopeB: string,
  rpdB: number,
  rpmB: number,
): Promise<{ ok: boolean; retry_after: number }> => {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("craft_ai_try_consume_pair", {
    p_scope_a: scopeA,
    p_rpd_a: rpdA,
    p_rpm_a: rpmA,
    p_scope_b: scopeB,
    p_rpd_b: rpdB,
    p_rpm_b: rpmB,
  }).single();
  if (error) throw new Error(error.message);
  return data as { ok: boolean; retry_after: number };
};

const pickModel = async (
  preferred: string[],
  allowed: Set<string>,
  siteTotal: { enabled: boolean; rpd: number; rpm: number },
) => {
  const limits = parseModelLimits();
  let lastRetryAfter = 60;
  for (const model of preferred) {
    if (!allowed.has(model)) continue;
    const lim = limits[model] ?? defaultModelLimits(model);
    const scope = `gemini:${model}`;
    if (siteTotal.enabled) {
      const res = await consumePair("site_total", siteTotal.rpd, siteTotal.rpm, scope, lim.rpd, lim.rpm);
      lastRetryAfter = res.retry_after || lastRetryAfter;
      if (res.ok) return { model, retryAfter: 0 };
    } else {
      const res = await consume(scope, lim.rpd, lim.rpm);
      lastRetryAfter = res.retry_after || lastRetryAfter;
      if (res.ok) return { model, retryAfter: 0 };
    }
  }
  return { model: null as string | null, retryAfter: lastRetryAfter };
};

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: { message: "Method not allowed" } }, cors);

  const apiKey = (Deno.env.get("GEMINI_API_KEY") || "").trim();
  if (!apiKey) return json(500, { error: { message: "Missing GEMINI_API_KEY secret." } }, cors);

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const fnIndex = parts.indexOf("craft-ai");
  const subPath = fnIndex >= 0 ? `/${parts.slice(fnIndex + 1).join("/")}` : "/";

  const allowedModelsEnv = splitCsv(Deno.env.get("GEMINI_ALLOWED_MODELS") || "gemini-2.5-flash");
  const allowedModels = new Set(allowedModelsEnv.length ? allowedModelsEnv : ["gemini-2.5-flash"]);

  // Optional site-total cap across all models (consumed atomically with the chosen model)
  const siteTotalRpd = Math.max(0, Math.floor(Number(Deno.env.get("SITE_TOTAL_RPD_LIMIT") || "0") || 0));
  const siteTotalRpm = Math.max(0, Math.floor(Number(Deno.env.get("SITE_TOTAL_RPM_LIMIT") || "0") || 0));
  const siteTotal = { enabled: (siteTotalRpd > 0) || (siteTotalRpm > 0), rpd: siteTotalRpd, rpm: siteTotalRpm };

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json(400, { error: { message: "Invalid JSON body" } }, cors);
  }

  if (subPath === "/api/gemini") {
    const requested = String(body?.model || "").trim();
    let model: string | null = null;
    if (requested) {
      if (!allowedModels.has(requested)) {
        return json(400, { error: { message: `Model not allowed: ${requested}` } }, cors);
      }
      const lim = parseModelLimits()[requested] ?? defaultModelLimits(requested);
      if (siteTotal.enabled) {
        const res = await consumePair("site_total", siteTotal.rpd, siteTotal.rpm, `gemini:${requested}`, lim.rpd, lim.rpm);
        if (!res.ok) {
          return json(429, { error: { message: "Rate limit exceeded." } }, { ...cors, "Retry-After": String(res.retry_after) });
        }
      } else {
        const rl = await consume(`gemini:${requested}`, lim.rpd, lim.rpm);
        if (!rl.ok) {
          return json(429, { error: { message: "Rate limit exceeded." } }, { ...cors, "Retry-After": String(rl.retry_after) });
        }
      }
      model = requested;
    } else {
      const preferred = splitCsv(Deno.env.get("GEMINI_MARKCRAFT_MODELS") || "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash");
      const picked = await pickModel(preferred, allowedModels, siteTotal);
      if (!picked.model) {
        return json(429, { error: { message: "Rate limit exceeded for all allowed models." } }, { ...cors, "Retry-After": String(picked.retryAfter || 60) });
      }
      model = picked.model;
    }

    const payload: Record<string, unknown> = {
      contents: body?.contents ?? [],
    };
    if (body?.systemInstruction != null) payload.systemInstruction = body.systemInstruction;

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await upstream.text();
    return new Response(data, { status: upstream.status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
  }

  if (subPath === "/api/flashcraft/generate_deck") {
    const preferred = splitCsv(Deno.env.get("GEMINI_FLASHCRAFT_MODELS") || "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash");
    const picked = await pickModel(preferred, allowedModels, siteTotal);
    if (!picked.model) {
      return json(429, { error: { message: "Rate limit exceeded for all allowed models." } }, { ...cors, "Retry-After": String(picked.retryAfter || 60) });
    }
    const model = picked.model;

    const requirements = String(body?.requirements || "").trim();
    const sourceText = String(body?.sourceText || "").trim();
    const totalCards = Math.max(10, Math.min(200, Number(body?.totalCards || 60) || 60));
    if (!sourceText) return json(400, { error: { message: "sourceText is required" } }, cors);
    if (sourceText.length > 200_000) return json(413, { error: { message: "sourceText too large" } }, cors);

    const systemText =
      `You are FlashCraft Deck Generator.\n` +
      `Return ONLY a valid JSON object with this exact schema:\n` +
      `{ "title": string, "desc": string, "cards": [{ "front": string, "back": string }] }\n` +
      `Rules:\n` +
      `1) No Markdown, no code fences, no explanations.\n` +
      `2) cards length should be close to TOTAL.\n` +
      `3) front/back must be non-empty; avoid duplicates.\n` +
      `4) Keep content faithful to the source; do not hallucinate facts.\n` +
      `5) Use Markdown + LaTeX where helpful.\n`;

    const userText =
      `[TOTAL]\n${totalCards}\n\n` +
      `[USER_REQUIREMENTS]\n${requirements || "N/A"}\n\n` +
      `[SOURCE]\n${sourceText}\n`;

    const payload = {
      contents: [{ role: "user", parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: systemText }] },
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const upstreamJson = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return json(502, { error: { message: upstreamJson?.error?.message || `${upstream.status} ${upstream.statusText}` } }, cors);
    }
    const text = extractTextFromGemini(upstreamJson);
    const deck = extractJsonObject(text);
    const cards = Array.isArray(deck?.cards) ? deck!.cards : null;
    if (!deck || !cards) return json(502, { error: { message: "Model output is not a valid deck JSON" } }, cors);
    return json(200, { title: deck.title ?? "", desc: deck.desc ?? "", cards }, cors);
  }

  return json(404, { error: { message: "Not found" } }, cors);
});
