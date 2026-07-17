#!/usr/bin/env bash
# Promote beta → main as release vX.Y.Z. Run from main. See RELEASING.md.
#
#   scripts/release.sh 0.5.0 [--skip-evals]
#
# Steps, in order — any failure aborts the merge and leaves main untouched:
#   1. preflight     clean tree, on main, main up to date with origin
#   2. merge         git merge --no-ff --no-commit origin/beta
#   3. channel fix   restore main's marketplace.json; write the new version
#                    into both plugin manifests (a plain merge would leak the
#                    beta channel files onto stable — this is the ONLY
#                    supported way to merge beta into main)
#   4. guard         node scripts/check-channel.mjs main
#   5. tests         validate-skills + hooks tests
#   6. evals         routing evals against the exact tree being released
#                    (skippable with --skip-evals if CI already ran them on
#                    the promotion PR)
#   7. commit + tag  "release: vX.Y.Z", tag vX.Y.Z
#   8. push          prompts before pushing main + tag (the push IS the
#                    release: stable users' pinned version moves)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

VERSION="${1:-}"
SKIP_EVALS=0
[[ "${2:-}" == "--skip-evals" ]] && SKIP_EVALS=1

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: scripts/release.sh <X.Y.Z> [--skip-evals]" >&2
  exit 1
fi

abort_merge() {
  git merge --abort 2>/dev/null || true
  git checkout -q -- .claude-plugin .codex-plugin 2>/dev/null || true
}

# ── 1. preflight ─────────────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean" >&2
  exit 1
fi
if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  echo "error: releases run from main (currently on $(git rev-parse --abbrev-ref HEAD))" >&2
  exit 1
fi
git fetch origin --quiet
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "error: local main is not in sync with origin/main — pull/push first" >&2
  exit 1
fi
if ! git rev-parse --verify --quiet refs/remotes/origin/beta >/dev/null; then
  echo "error: origin/beta does not exist — run scripts/cut-beta.sh first" >&2
  exit 1
fi
if git rev-parse --verify --quiet "refs/tags/v$VERSION" >/dev/null; then
  echo "error: tag v$VERSION already exists" >&2
  exit 1
fi
CURRENT_VERSION=$(node -p 'JSON.parse(require("node:fs").readFileSync(".claude-plugin/plugin.json","utf8")).version')
echo "Releasing: $CURRENT_VERSION → $VERSION  (origin/beta $(git rev-parse --short origin/beta) → main)"

# ── 2. merge (no commit yet) ─────────────────────────────────────────────────
trap abort_merge ERR
git merge --no-ff --no-commit origin/beta >/dev/null || {
  echo "error: merge has conflicts — resolve manually or fix beta first" >&2
  abort_merge
  exit 1
}

# ── 3. restore channel files + set version ──────────────────────────────────
git checkout HEAD -- .claude-plugin/marketplace.json
node - "$VERSION" <<'EOF'
const { readFileSync, writeFileSync } = require("node:fs");
const version = process.argv[2];
for (const path of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  // Rebuild with version in its conventional slot after name.
  const { name, version: _drop, ...rest } = manifest;
  writeFileSync(path, JSON.stringify({ name, version, ...rest }, null, 2) + "\n");
}
EOF
git add .claude-plugin/plugin.json .codex-plugin/plugin.json .claude-plugin/marketplace.json

# ── 4-6. gates ───────────────────────────────────────────────────────────────
node scripts/check-channel.mjs main
npm run --silent test:skills
npm run --silent test:hooks
if [[ "$SKIP_EVALS" -eq 1 ]]; then
  echo "skipping routing evals (--skip-evals)"
else
  node evals/run-routing.mjs
fi
trap - ERR

# ── 7. commit + tag ──────────────────────────────────────────────────────────
git commit -m "release: v$VERSION"
git tag "v$VERSION"
echo
echo "release v$VERSION committed and tagged locally."
echo

# ── 8. push (the actual release) ─────────────────────────────────────────────
read -r -p "Push main + v$VERSION to origin now? This ships to stable users. [y/N] " reply
if [[ "$reply" == "y" || "$reply" == "Y" ]]; then
  git push origin main "v$VERSION"
  echo "released. Stable users pick up v$VERSION on their next plugin update."
else
  echo "not pushed. When ready:"
  echo
  echo "  git push origin main v$VERSION"
fi
