#!/usr/bin/env bash
# One-time setup: create the beta channel branch from main.
#
# The beta branch differs from main in exactly two channel files (enforced by
# scripts/check-channel.mjs):
#   - .claude-plugin/marketplace.json  name: "incubator" → "incubator-beta"
#   - .claude-plugin/plugin.json       version removed (every commit then
#                                      ships to beta users via its SHA)
#
# After this, feature PRs target beta; scripts/release.sh promotes beta→main.
# See RELEASING.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean" >&2
  exit 1
fi

git fetch origin --quiet

if git rev-parse --verify --quiet refs/remotes/origin/beta >/dev/null; then
  echo "error: origin/beta already exists — the beta channel is already cut" >&2
  exit 1
fi

echo "Creating beta from origin/main ($(git rev-parse --short origin/main))..."
git checkout -q -b beta origin/main

node - <<'EOF'
const { readFileSync, writeFileSync } = require("node:fs");

const mkt = JSON.parse(readFileSync(".claude-plugin/marketplace.json", "utf8"));
mkt.name = "incubator-beta";
writeFileSync(".claude-plugin/marketplace.json", JSON.stringify(mkt, null, 2) + "\n");

const manifest = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
delete manifest.version;
writeFileSync(".claude-plugin/plugin.json", JSON.stringify(manifest, null, 2) + "\n");
EOF

node scripts/check-channel.mjs beta

git add .claude-plugin/marketplace.json .claude-plugin/plugin.json
git commit -m "chore(channel): initialize beta channel invariants

Marketplace registers as \"incubator-beta\" so it can coexist with the
stable \"incubator\" marketplace; plugin.json drops its version pin so
every commit on this branch ships to beta users via its SHA.
See RELEASING.md."

echo
echo "beta branch created locally. Push it with:"
echo
echo "  git push origin HEAD:refs/heads/beta"
echo
echo "Then set the GitHub default branch to beta so feature PRs target it:"
echo
echo "  gh api -X PATCH repos/{owner}/{repo} -f default_branch=beta"
