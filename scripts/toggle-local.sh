#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_MARKETPLACE_ROOT="$(cd "$REPO_DIR/.." && pwd)"
MARKETPLACE_NAME="incubator"
PROD_SOURCE="the-incubator/incubator-build-plugin"
PLUGIN_NAME="incubator-build"

usage() {
  cat <<'EOF'
Usage: scripts/toggle-local.sh [claude|codex] [local|prod]

Defaults to Claude and toggles between local/prod. For Codex, this registers the
marketplace; enable the plugin from the Codex app/plugin UI after adding it.
EOF
}

PLATFORM="${1:-claude}"
TARGET="${2:-}"

case "$PLATFORM" in
  claude|codex) ;;
  -h|--help) usage; exit 0 ;;
  *) echo "error: platform must be 'claude' or 'codex'" >&2; usage >&2; exit 1 ;;
esac

case "$TARGET" in
  ""|local|prod) ;;
  *) echo "error: target must be 'local' or 'prod'" >&2; usage >&2; exit 1 ;;
esac

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' not found on PATH" >&2
    exit 1
  fi
}

confirm() {
  read -r -p "Proceed? [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]]
}

detect_claude_mode() {
  local known="$HOME/.claude/plugins/known_marketplaces.json"
  if [[ ! -f "$known" ]]; then
    echo "none"; return
  fi
  local entry
  entry=$(jq -r --arg n "$MARKETPLACE_NAME" '.[$n] // empty' "$known")
  if [[ -z "$entry" ]]; then
    echo "none"; return
  fi
  local src_type
  src_type=$(jq -r '.source.source // ""' <<<"$entry")
  case "$src_type" in
    github) echo "prod" ;;
    local|path|file) echo "local" ;;
    *)
      local loc
      loc=$(jq -r '.installLocation // ""' <<<"$entry")
      if [[ "$loc" == "$REPO_DIR" ]]; then echo "local"; else echo "unknown"; fi
      ;;
  esac
}

detect_codex_mode() {
  local config="$HOME/.codex/config.toml"
  if [[ ! -f "$config" ]]; then
    echo "none"; return
  fi
  awk -v name="$MARKETPLACE_NAME" -v repo="$CODEX_MARKETPLACE_ROOT" '
    $0 == "[marketplaces." name "]" { in_block=1; found=1; next }
    /^\[/ && in_block { in_block=0 }
    in_block && $1 == "source_type" && $3 ~ /"local"/ { local_type=1 }
    in_block && $1 == "source" {
      if (index($0, repo) > 0) local_source=1
      if (index($0, "the-incubator/incubator-build-plugin") > 0) prod_source=1
    }
    END {
      if (!found) print "none";
      else if (local_type && local_source) print "local";
      else if (prod_source) print "prod";
      else print "unknown";
    }
  ' "$config"
}

opposite_or_default() {
  local current="$1"
  case "$current" in
    prod) echo "local" ;;
    local) echo "prod" ;;
    *) echo "local" ;;
  esac
}

show_plan() {
  local platform="$1"
  local target="$2"
  echo
  echo "Plan:"
  if [[ "$platform" == "claude" ]]; then
    echo "  1. claude plugin marketplace remove $MARKETPLACE_NAME"
    if [[ "$target" == "local" ]]; then
      echo "  2. claude plugin marketplace add $REPO_DIR"
    else
      echo "  2. claude plugin marketplace add $PROD_SOURCE"
    fi
    echo "  3. claude plugin install $PLUGIN_NAME@$MARKETPLACE_NAME"
  else
    echo "  1. codex plugin marketplace remove $MARKETPLACE_NAME"
    if [[ "$target" == "local" ]]; then
      echo "  2. codex plugin marketplace add $CODEX_MARKETPLACE_ROOT"
    else
      echo "  2. codex plugin marketplace add $PROD_SOURCE"
    fi
    echo "  3. Enable $PLUGIN_NAME@$MARKETPLACE_NAME in the Codex app/plugin UI"
  fi
  echo
}

swap_claude_to() {
  local target="$1"
  claude plugin marketplace remove "$MARKETPLACE_NAME" || true
  if [[ "$target" == "local" ]]; then
    claude plugin marketplace add "$REPO_DIR"
  else
    claude plugin marketplace add "$PROD_SOURCE"
  fi
  claude plugin install "$PLUGIN_NAME@$MARKETPLACE_NAME"
  echo "done. restart Claude Code sessions to pick up the change."
}

swap_codex_to() {
  local target="$1"
  codex plugin marketplace remove "$MARKETPLACE_NAME" || true
  if [[ "$target" == "local" ]]; then
    codex plugin marketplace add "$CODEX_MARKETPLACE_ROOT"
  else
    codex plugin marketplace add "$PROD_SOURCE"
  fi
  echo "done. restart Codex, then enable $PLUGIN_NAME@$MARKETPLACE_NAME if it is not already enabled."
}

if [[ "$PLATFORM" == "claude" ]]; then
  require_cmd claude
  require_cmd jq
  CURRENT=$(detect_claude_mode)
else
  require_cmd codex
  CURRENT=$(detect_codex_mode)
fi

if [[ -z "$TARGET" ]]; then
  TARGET=$(opposite_or_default "$CURRENT")
fi

case "$CURRENT" in
  prod) echo "Current: PROD  ($PROD_SOURCE)" ;;
  local) echo "Current: LOCAL ($REPO_DIR)" ;;
  none) echo "Current: (no '$MARKETPLACE_NAME' marketplace registered)" ;;
  *) echo "Current: UNKNOWN" ;;
esac
TARGET_LABEL=$(printf '%s' "$TARGET" | tr '[:lower:]' '[:upper:]')
echo "Target:  $TARGET_LABEL"

show_plan "$PLATFORM" "$TARGET"
if confirm; then
  if [[ "$PLATFORM" == "claude" ]]; then
    swap_claude_to "$TARGET"
  else
    swap_codex_to "$TARGET"
  fi
else
  echo "aborted."
fi
