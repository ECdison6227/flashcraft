#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import time
import sqlite3
from datetime import datetime, timezone, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def _json_response(handler: SimpleHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _default_model_limits(model: str) -> tuple[int, int]:
    """
    Default limits for Gemini Free tier (based on the user's rate-limit table).
    Returns (RPD, RPM).

    You can override with:
      - GEMINI_MODEL_LIMITS_JSON='{"gemini-2.5-flash":{"rpd":20,"rpm":5}, ...}'
    """
    if model == "gemini-2.5-flash":
        return 20, 5
    if model == "gemini-2.5-flash-lite":
        return 20, 10
    if model == "gemini-3-flash":
        return 20, 5
    if model.startswith("gemma-3-"):
        return 14400, 30
    return 20, 5


def _parse_model_limits() -> dict[str, tuple[int, int]]:
    raw = (os.environ.get("GEMINI_MODEL_LIMITS_JSON") or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    limits: dict[str, tuple[int, int]] = {}
    if isinstance(data, dict):
        for k, v in data.items():
            if not isinstance(k, str) or not isinstance(v, dict):
                continue
            rpd = v.get("rpd")
            rpm = v.get("rpm")
            try:
                rpd_i = int(rpd)
                rpm_i = int(rpm)
            except Exception:
                continue
            limits[k] = (max(0, rpd_i), max(0, rpm_i))
    return limits


def _split_csv(value: str) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v and v.strip()]


def _extract_text_from_gemini(payload: dict) -> str:
    try:
        candidates = payload.get("candidates") or []
        content = (candidates[0] or {}).get("content") or {}
        parts = content.get("parts") or []
        text = (parts[0] or {}).get("text") or ""
        return str(text)
    except Exception:
        return ""


def _extract_json_object(text: str) -> dict | None:
    text = (text or "").strip()
    if not text:
        return None
    # Fast path
    if text.startswith("{") and text.endswith("}"):
        try:
            return json.loads(text)
        except Exception:
            pass
    # Try to find the first {...} block
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                chunk = text[start : i + 1]
                try:
                    return json.loads(chunk)
                except Exception:
                    return None
    return None


class DevHandler(SimpleHTTPRequestHandler):
    def _get_db(self) -> sqlite3.Connection:
        db_path = os.environ.get("QUOTA_DB_PATH", ".quota.sqlite3")
        conn = sqlite3.connect(db_path, timeout=5)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS usage_day (day TEXT NOT NULL, scope TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day, scope))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS usage_minute (minute INTEGER NOT NULL, scope TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(minute, scope))"
        )
        return conn

    def _consume_limit(self, scope: str, rpd_limit: int, rpm_limit: int) -> tuple[bool, int, dict]:
        """
        Shared limits (all visitors share the same pool), per scope.
        """
        now = datetime.now(timezone.utc)
        day = now.strftime("%Y-%m-%d")
        minute = int(time.time() // 60)

        conn = self._get_db()
        try:
            cur = conn.cursor()

            # Cleanup old minute buckets (keep last 10 minutes)
            cur.execute("DELETE FROM usage_minute WHERE minute < ?", (minute - 10,))

            cur.execute("SELECT count FROM usage_day WHERE day = ? AND scope = ?", (day, scope))
            row = cur.fetchone()
            day_count = int(row[0]) if row else 0

            cur.execute("SELECT count FROM usage_minute WHERE minute = ? AND scope = ?", (minute, scope))
            row = cur.fetchone()
            minute_count = int(row[0]) if row else 0

            allowed = True
            retry_after = 0
            if rpd_limit > 0 and day_count >= rpd_limit:
                allowed = False
                # seconds until next UTC day boundary
                next_midnight = (now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1))
                retry_after = max(60, int((next_midnight - now).total_seconds()))
            if allowed and rpm_limit > 0 and minute_count >= rpm_limit:
                allowed = False
                retry_after = max(1, 60 - int(time.time() % 60))

            headers = {
                "X-RateLimit-Scope": scope,
                "X-RateLimit-RPD-Limit": str(rpd_limit),
                "X-RateLimit-RPD-Used": str(day_count),
                "X-RateLimit-RPM-Limit": str(rpm_limit),
                "X-RateLimit-RPM-Used": str(minute_count),
            }

            if not allowed:
                return False, retry_after, headers

            # Consume one unit
            cur.execute(
                "INSERT INTO usage_day(day, scope, count) VALUES(?,?,1) ON CONFLICT(day, scope) DO UPDATE SET count = count + 1",
                (day, scope),
            )
            cur.execute(
                "INSERT INTO usage_minute(minute, scope, count) VALUES(?,?,1) ON CONFLICT(minute, scope) DO UPDATE SET count = count + 1",
                (minute, scope),
            )
            conn.commit()

            # Update after increment
            headers["X-RateLimit-RPD-Used"] = str(day_count + 1)
            headers["X-RateLimit-RPM-Used"] = str(minute_count + 1)
            return True, 0, headers
        finally:
            conn.close()

    def _pick_model(self, preferred: list[str], allowed: set[str]) -> tuple[str | None, dict[str, str] | None, int]:
        """
        Pick the first model that:
        - is allowed
        - has remaining quota (per-model scope)
        Returns (model, rate_limit_headers, retry_after_if_blocked).
        """
        model_limits = _parse_model_limits()
        last_headers = None
        max_retry_after = 0
        for model in preferred:
            if model not in allowed:
                continue
            rpd, rpm = model_limits.get(model, _default_model_limits(model))
            ok, retry_after, headers = self._consume_limit(f"gemini:{model}", rpd, rpm)
            last_headers = headers
            max_retry_after = max(max_retry_after, retry_after)
            if ok:
                return model, headers, 0
        return None, last_headers, max_retry_after or 60

    def do_OPTIONS(self) -> None:  # noqa: N802
        # For completeness; same-origin requests won't need CORS, but preflight can happen.
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.end_headers()
            return
        super().do_OPTIONS()

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/api/gemini", "/api/flashcraft/generate_deck"):
            _json_response(self, 404, {"error": {"message": "Not found"}})
            return

        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            _json_response(
                self,
                500,
                {
                    "error": {
                        "message": "Missing GEMINI_API_KEY env var. Start server with GEMINI_API_KEY=... python3 dev_server.py"
                    }
                },
            )
            return

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0

        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            _json_response(self, 400, {"error": {"message": "Invalid JSON body"}})
            return

        allowed_models = set(_split_csv(os.environ.get("GEMINI_ALLOWED_MODELS", "gemini-2.5-flash")))
        if not allowed_models:
            allowed_models = {"gemini-2.5-flash"}

        # Optional global "site total" cap across ALL models
        total_rpd_limit = int(os.environ.get("SITE_TOTAL_RPD_LIMIT", "0"))
        total_rpm_limit = int(os.environ.get("SITE_TOTAL_RPM_LIMIT", "0"))
        total_headers = {}
        if total_rpd_limit > 0 or total_rpm_limit > 0:
            ok_total, retry_after_total, total_headers = self._consume_limit("site_total", total_rpd_limit, total_rpm_limit)
            if not ok_total:
                self.send_response(429)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Retry-After", str(retry_after_total))
                for k, v in total_headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(json.dumps({"error": {"message": "Site quota exceeded. Try again later."}}, ensure_ascii=False).encode("utf-8"))
                return

        rl_headers = {}
        if self.path == "/api/gemini":
            requested = (body.get("model") or "").strip()
            if requested and requested not in allowed_models:
                _json_response(self, 400, {"error": {"message": f"Model not allowed: {requested}"}})
                return

            if requested:
                model = requested
                rpd, rpm = _parse_model_limits().get(model, _default_model_limits(model))
                ok, retry_after, rl_headers = self._consume_limit(f"gemini:{model}", rpd, rpm)
                if not ok:
                    self.send_response(429)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Retry-After", str(retry_after))
                    for k, v in {**total_headers, **rl_headers}.items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": {"message": "Rate limit exceeded for requested model."}}, ensure_ascii=False).encode("utf-8"))
                    return
            else:
                preferred = _split_csv(os.environ.get("GEMINI_MARKCRAFT_MODELS", "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash"))
                model, rl_headers, retry_after = self._pick_model(preferred, allowed_models)
                if not model:
                    self.send_response(429)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Retry-After", str(retry_after))
                    for k, v in {**total_headers, **(rl_headers or {})}.items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": {"message": "Rate limit exceeded for all allowed models."}}, ensure_ascii=False).encode("utf-8"))
                    return

            payload = {
                "contents": body.get("contents") or [],
            }
            if body.get("systemInstruction") is not None:
                payload["systemInstruction"] = body.get("systemInstruction")
        else:
            preferred = _split_csv(os.environ.get("GEMINI_FLASHCRAFT_MODELS", "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash"))
            model, rl_headers, retry_after = self._pick_model(preferred, allowed_models)
            if not model:
                self.send_response(429)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Retry-After", str(retry_after))
                for k, v in {**total_headers, **(rl_headers or {})}.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(json.dumps({"error": {"message": "Rate limit exceeded for all allowed models."}}, ensure_ascii=False).encode("utf-8"))
                return

            requirements = (body.get("requirements") or "").strip()
            source_text = (body.get("sourceText") or "").strip()
            total = int(body.get("totalCards") or 60)
            if not source_text:
                _json_response(self, 400, {"error": {"message": "sourceText is required"}})
                return
            if len(source_text) > 200_000:
                _json_response(self, 413, {"error": {"message": "sourceText too large"}})
                return
            total = max(10, min(total, 200))

            system_text = (
                "You are FlashCraft Deck Generator.\n"
                "Return ONLY a valid JSON object with this exact schema:\n"
                '{ "title": string, "desc": string, "cards": [{ "front": string, "back": string }] }\n'
                "Rules:\n"
                "1) No Markdown, no code fences, no explanations.\n"
                "2) cards length should be close to TOTAL.\n"
                "3) front/back must be non-empty; avoid duplicates.\n"
                "4) Keep content faithful to the source; do not hallucinate facts.\n"
                "5) Use Markdown + LaTeX where helpful.\n"
            )
            user_text = (
                f"[TOTAL]\n{total}\n\n"
                f"[USER_REQUIREMENTS]\n{requirements or 'N/A'}\n\n"
                f"[SOURCE]\n{source_text}\n"
            )
            payload = {
                "contents": [{"role": "user", "parts": [{"text": user_text}]}],
                "systemInstruction": {"parts": [{"text": system_text}]},
            }

        endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        req = Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urlopen(req, timeout=60) as resp:
                data = resp.read()
                status = getattr(resp, "status", 200) or 200
        except HTTPError as e:
            data = e.read() if hasattr(e, "read") else b""
            status = e.code
        except URLError as e:
            _json_response(self, 502, {"error": {"message": f"Upstream network error: {e.reason}"}})
            return
        except Exception as e:
            _json_response(self, 502, {"error": {"message": f"Upstream error: {type(e).__name__}: {e}"}})
            return

        # For FlashCraft deck generation: return the parsed deck JSON directly (not the full Gemini payload)
        if self.path == "/api/flashcraft/generate_deck" and 200 <= status < 300:
            try:
                upstream = json.loads(data.decode("utf-8"))
            except Exception:
                _json_response(self, 502, {"error": {"message": "Upstream returned invalid JSON"}})
                return

            text = _extract_text_from_gemini(upstream)
            deck = _extract_json_object(text)
            if not deck or not isinstance(deck, dict) or not isinstance(deck.get("cards"), list):
                _json_response(self, 502, {"error": {"message": "Model output is not a valid deck JSON"}})
                return
            _json_response(self, 200, {"title": deck.get("title", ""), "desc": deck.get("desc", ""), "cards": deck.get("cards", [])})
            return

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        # If you want to open this to other origins, keep these; for same-origin they're harmless.
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in {**total_headers, **rl_headers}.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    port = int(os.environ.get("PORT", "5173"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), DevHandler)
    print(f"Dev server running: http://localhost:{port}/markcraft.html", flush=True)
    print("Gemini proxy endpoint: POST /api/gemini (reads GEMINI_API_KEY)", flush=True)
    print("FlashCraft deck endpoint: POST /api/flashcraft/generate_deck (reads GEMINI_API_KEY)", flush=True)
    print("Model allow-list: GEMINI_ALLOWED_MODELS=gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash,gemma-3-1b,...", flush=True)
    print("Model rotation:", flush=True)
    print("  GEMINI_MARKCRAFT_MODELS=gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash", flush=True)
    print("  GEMINI_FLASHCRAFT_MODELS=gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash", flush=True)
    print("Per-model limits override: GEMINI_MODEL_LIMITS_JSON='{\"gemini-2.5-flash\":{\"rpd\":20,\"rpm\":5}}'", flush=True)
    print("Optional site-total cap: SITE_TOTAL_RPD_LIMIT=0 SITE_TOTAL_RPM_LIMIT=0", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping...", flush=True)
        return 0


if __name__ == "__main__":
    os.chdir(os.path.dirname(__file__) or ".")
    raise SystemExit(main())
