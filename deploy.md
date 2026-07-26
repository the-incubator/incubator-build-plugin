# Deploy

## Deploy Configuration (managed by /inc:setup-deploy)

- Platform: custom (does-not-deploy)
- Production branch: main
- Production URL: none - this repo ships no running service
- Deploy trigger: none. This is a Claude Code / Codex **plugin source repo**, not a deployed app. "Release" means: bump `version` in `.claude-plugin/plugin.json` and merge to `main`; installs pull the new version when their plugin updater runs (Claude Code treats that `version` string as an update pin).
- CLI auth check: `gh auth status`
- Reauth: `gh auth login`
- Deploy window: none

> The `Deploy window:` line is policy, not a command. `none` means no restriction - the merge skill
> just merges. It still runs its lightweight risk check and confirms on riskier changes.

**Deploy status (newest production deploy):**
`echo does-not-deploy`

**Wait for a specific deploy to reach Ready:**
`echo does-not-deploy`

**Early-log scan (errors in the first minutes):**
`echo does-not-deploy`

**Health check:**
none - there is no runtime surface to probe. Post-merge correctness is covered by the `validate`
workflow (`npm run test:skills`) on the PR, which must be green before the merge gates pass.

### Notes for the merge/ship skills

There is nothing to observe after a merge here: no service starts, no URL changes, no logs are
produced. `inc:merge-pr-5` should report `Observation: skipped - plugin source repo, no runtime
deploy` and finish. Do not treat the absence of a deploy as a failed observation.

The real post-merge verification is on the consumer side: a user's plugin updater pulls the new
`version`, and a stale local checkout can keep running old skill code even after main moves.

### Release channels (as of 2026-07-26)

The two-channel model (`main` = stable pinned, `beta` = auto-ship, promotion via
`scripts/release.sh`) is **proposed but not yet in place** - there is no `beta` branch on origin and
no `scripts/release.sh` on `main`. Until that lands, ship plugin work as ordinary PRs into `main`
with a `version` bump in the same PR. Re-run `/inc:setup-deploy` once the channel model merges.
