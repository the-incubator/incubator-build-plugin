#!/bin/bash
# Scan for new environment variables in changed code
# Exit codes: 0=no new vars or all configured, 1=new vars found needing config

set -e

# Get env vars newly referenced in diff vs origin/main (added lines only)
DIFF_ENV_VARS=$(git diff origin/main -- server/ shared/ client/ 2>/dev/null | grep '^+' | grep -oE 'process\.env\.[A-Z_]+|import\.meta\.env\.[A-Z_]+' | sort -u || true)

if [ -z "$DIFF_ENV_VARS" ]; then
    echo "STATUS: pass"
    echo "MESSAGE: No new environment variables detected"
    exit 0
fi

# Extract just the var names
VAR_NAMES=$(echo "$DIFF_ENV_VARS" | sed -E 's/(process\.env\.|import\.meta\.env\.)//g' | sort -u)

# Check which are already in cloudbuild.yaml
CLOUDBUILD_VARS=""
if [ -f "cloudbuild.yaml" ]; then
    CLOUDBUILD_VARS=$(grep -oE '_[A-Z_]+' cloudbuild.yaml 2>/dev/null | sed 's/^_//' | sort -u || true)
fi

# Find new vars not in cloudbuild
NEW_VARS=""
for var in $VAR_NAMES; do
    if ! echo "$CLOUDBUILD_VARS" | grep -q "^${var}$"; then
        NEW_VARS="$NEW_VARS $var"
    fi
done

NEW_VARS=$(echo "$NEW_VARS" | xargs)  # trim whitespace

if [ -z "$NEW_VARS" ]; then
    echo "STATUS: pass"
    echo "MESSAGE: All environment variables are configured"
    echo "VARS_FOUND:"
    echo "$VAR_NAMES" | while read -r v; do echo "  - $v (configured)"; done
    exit 0
fi

echo "STATUS: warn"
echo "MESSAGE: New environment variables need configuration"
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

    # Indicate if it's frontend or backend
    if echo "$var" | grep -q "^VITE_"; then
        echo "    Type: Frontend (add to cloudbuild.yaml)"
    else
        echo "    Type: Backend (add to Cloud Run)"
    fi
done
exit 1
