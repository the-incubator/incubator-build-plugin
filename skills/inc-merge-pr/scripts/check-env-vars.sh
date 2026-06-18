#!/bin/bash
# Scan for new environment variables in changed code.
# Platform-agnostic: finds env vars newly referenced in the diff that the project
# doesn't already document, so they can be configured in whatever deploy platform
# the project uses. We can't query an arbitrary platform's config, so committed
# .env* files are used as a neutral proxy for "already known".
# Exit codes: 0=no new vars (or all known), 1=new vars found needing config.

set -e

# Env vars newly referenced in the diff vs origin/main (added lines only).
DIFF_ENV_VARS=$(git diff origin/main 2>/dev/null | grep '^+' | grep -oE 'process\.env\.[A-Z_]+|import\.meta\.env\.[A-Z_]+' | sort -u || true)

if [ -z "$DIFF_ENV_VARS" ]; then
    echo "STATUS: pass"
    echo "MESSAGE: No new environment variables detected"
    exit 0
fi

# Extract just the var names
VAR_NAMES=$(echo "$DIFF_ENV_VARS" | sed -E 's/(process\.env\.|import\.meta\.env\.)//g' | sort -u)

# Vars the project already documents, from any committed example/env files.
# Platform-neutral proxy for "already configured" — a documented var is treated
# as known regardless of which deploy platform actually holds its value.
KNOWN_VARS=""
for f in .env.example .env.sample .env.template .env .env.local .env.development .env.production .env.staging .env.test; do
    if [ -f "$f" ]; then
        FOUND=$(grep -oE '^(export[[:space:]]+)?[A-Z_][A-Z0-9_]*=' "$f" 2>/dev/null | sed -E 's/^export[[:space:]]+//; s/=$//' || true)
        KNOWN_VARS="$KNOWN_VARS
$FOUND"
    fi
done
KNOWN_VARS=$(echo "$KNOWN_VARS" | sort -u)

# Find referenced vars not already known to the project
NEW_VARS=""
for var in $VAR_NAMES; do
    if ! echo "$KNOWN_VARS" | grep -qx "$var"; then
        NEW_VARS="$NEW_VARS $var"
    fi
done

NEW_VARS=$(echo "$NEW_VARS" | xargs)  # trim whitespace

if [ -z "$NEW_VARS" ]; then
    echo "STATUS: pass"
    echo "MESSAGE: All referenced environment variables are already known to the project"
    echo "VARS_FOUND:"
    echo "$VAR_NAMES" | while read -r v; do [ -n "$v" ] && echo "  - $v (known)"; done
    exit 0
fi

echo "STATUS: warn"
echo "MESSAGE: New environment variables need configuration in your deploy platform"
echo "NEW_VARS:"
for var in $NEW_VARS; do
    # Check if it's in .env
    LOCAL_VALUE=""
    if [ -f ".env" ]; then
        LOCAL_VALUE=$(grep "^${var}=" .env 2>/dev/null | cut -d'=' -f2- || true)
    fi

    if [ -n "$LOCAL_VALUE" ]; then
        echo "  - $var (local: set, prod: needs config)"
    else
        echo "  - $var (local: not set, prod: needs config)"
    fi

    # Build-time vs runtime scope, by naming convention only — no platform assumed.
    # Build-time-exposed vars are baked into the client bundle at build; runtime
    # vars are read by the server process.
    if echo "$var" | grep -qE '^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_)'; then
        echo "    Scope: build-time (exposed to the client bundle)"
    else
        echo "    Scope: runtime (server-side)"
    fi
done

# Paste-ready block: dotenv-format lines suitable for Railway Raw Editor,
# Vercel "Import .env", Netlify bulk add, Render env groups, Fly secrets import,
# Heroku config:set, etc. Each line is `KEY=VALUE` from local .env when
# available, otherwise `KEY=` so the user has a placeholder to fill in.
echo "PASTE_BLOCK:"
for var in $NEW_VARS; do
    LOCAL_LINE=""
    if [ -f ".env" ]; then
        LOCAL_LINE=$(grep "^${var}=" .env 2>/dev/null | head -n 1 || true)
    fi
    if [ -n "$LOCAL_LINE" ]; then
        echo "$LOCAL_LINE"
    else
        echo "${var}="
    fi
done
exit 1
