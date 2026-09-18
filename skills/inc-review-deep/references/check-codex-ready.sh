#!/usr/bin/env bash
# Preflight for cross-engine Codex reviewer dispatch.
# Exit 0 when Codex can actually run reviewers (binary + auth + usage headroom).
# Exit 1 with a single-line reason on stderr otherwise.
#
# Usage: bash references/check-codex-ready.sh
# Optional env:
#   CODEX_HOME                 default ~/.codex
#   INC_CODEX_USAGE_MAX_PCT    fail when primary used_percent >= this (default 100)
#   INC_CODEX_USAGE_URL        override usage endpoint
#
# Reasons (stderr):
#   codex CLI not found
#   not logged in
#   auth credentials missing
#   usage check failed: <detail>
#   rate limit reached (primary used_percent=N)
#   usage not allowed
#   spend control reached

set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
AUTH_FILE="${CODEX_HOME}/auth.json"
USAGE_URL="${INC_CODEX_USAGE_URL:-https://chatgpt.com/backend-api/codex/usage}"
MAX_PCT="${INC_CODEX_USAGE_MAX_PCT:-100}"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# 1) Binary present
if ! command -v codex >/dev/null 2>&1; then
  fail "codex CLI not found"
fi

# 2) Login status (covers missing/expired session for ChatGPT and API-key modes)
LOGIN_OUT="$(codex login status 2>&1 || true)"
LOGIN_LC="$(printf '%s' "$LOGIN_OUT" | tr '[:upper:]' '[:lower:]')"
case "$LOGIN_LC" in
  *logged\ in*|*api\ key*|*using\ chatgpt*|*authenticated*)
    ;;
  *)
    fail "not logged in"
    ;;
esac

# 3) Credentials on disk
if [[ ! -f "$AUTH_FILE" ]]; then
  fail "auth credentials missing"
fi

# 4) Live usage / rate-limit check for ChatGPT-auth accounts.
#    API-key-only installs skip the ChatGPT usage endpoint and rely on login status.
python3 - "$AUTH_FILE" "$USAGE_URL" "$MAX_PCT" <<'PY'
import json, sys, urllib.error, urllib.request, base64

auth_path, usage_url, max_pct_s = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    max_pct = float(max_pct_s)
except ValueError:
    max_pct = 100.0

def fail(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)

try:
    auth = json.loads(open(auth_path, encoding="utf-8").read())
except Exception as e:
    fail(f"auth credentials missing: {e}")

api_key = auth.get("OPENAI_API_KEY") or auth.get("openai_api_key")
tokens = auth.get("tokens") or {}
access = tokens.get("access_token")
id_token = tokens.get("id_token")
auth_mode = (auth.get("auth_mode") or "").lower()

# API-key mode: no ChatGPT usage endpoint. Login already succeeded.
if api_key and not access:
    sys.exit(0)
if auth_mode in ("apikey", "api_key", "openai-api-key") and not access:
    sys.exit(0)

if not access:
    fail("auth credentials missing")

def b64url_json(segment: str):
    pad = "=" * ((4 - len(segment) % 4) % 4)
    return json.loads(base64.urlsafe_b64decode(segment + pad))

account_id = None
if id_token and id_token.count(".") >= 2:
    try:
        claims = b64url_json(id_token.split(".")[1])
        a = claims.get("https://api.openai.com/auth") or {}
        account_id = a.get("chatgpt_account_id")
    except Exception:
        pass

# Live usage API is authoritative for ChatGPT-auth accounts.
# Do not gate on JWT subscription dates - those can lag renewals.
headers = {
    "Authorization": f"Bearer {access}",
    "Content-Type": "application/json",
    "User-Agent": "inc-review-deep-codex-preflight",
}
if account_id:
    headers["ChatGPT-Account-Id"] = account_id

req = urllib.request.Request(usage_url, headers=headers, method="GET")
try:
    with urllib.request.urlopen(req, timeout=12) as resp:
        data = json.loads(resp.read().decode("utf-8"))
except urllib.error.HTTPError as e:
    body = ""
    try:
        body = e.read().decode("utf-8", errors="replace")[:200]
    except Exception:
        pass
    if e.code in (401, 403):
        fail("not logged in")
    fail(f"usage check failed: HTTP {e.code} {body}")
except Exception as e:
    fail(f"usage check failed: {e}")

rate = data.get("rate_limit") or {}
allowed = rate.get("allowed")
limit_reached = bool(rate.get("limit_reached"))
primary = rate.get("primary_window") or {}
used = primary.get("used_percent")
spend = data.get("spend_control") or {}
credits = data.get("credits") or {}
reached_type = data.get("rate_limit_reached_type")

if allowed is False:
    fail("usage not allowed")
if limit_reached or reached_type:
    pct = used if used is not None else "?"
    fail(f"rate limit reached (primary used_percent={pct})")
if spend.get("reached") is True:
    fail("spend control reached")
if credits.get("overage_limit_reached") is True:
    fail("rate limit reached (credits overage)")
if used is not None:
    try:
        if float(used) >= max_pct:
            fail(f"rate limit reached (primary used_percent={used})")
    except (TypeError, ValueError):
        pass

sys.exit(0)
PY
