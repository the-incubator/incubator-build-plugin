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

### Observation: SKIP — do not run a deploy watch

**There are deliberately no status / wait-for-Ready / log-scan commands in this block.** Nothing
here deploys, so there is no state to poll. A placeholder probe would be worse than none: the
merge skill's wait loop only recognizes real deployment states, so a dummy command that exits 0
with unrecognized output drives it to `parse-error` after four polls instead of skipping — which
reads as a broken deploy watch rather than the no-op it actually is.

`inc:merge-pr-5` / `inc:ship-it`: treat this block as `OBSERVATION_READY=skip`, print
`Observation: skipped - plugin source repo, no runtime deploy`, and finish. Do not probe, do not
poll, do not run the post-deploy watch. The absence of a deploy is the expected outcome here, not
a failed observation.

**Health check:** none — there is no runtime surface. Post-merge correctness is covered by the
`validate` workflow (`npm run test:skills`), which must be green before the merge gates pass.

The real post-merge verification is on the consumer side: a user's plugin updater pulls the new
`version`, and a stale local checkout can keep running old skill code even after main moves.

### Release channels (as of 2026-07-26)

The two-channel model (`main` = stable pinned, `beta` = auto-ship, promotion via
`scripts/release.sh`) is **proposed but not yet in place** - there is no `beta` branch on origin and
no `scripts/release.sh` on `main`. Until that lands, ship plugin work as ordinary PRs into `main`
with a `version` bump in the same PR. Re-run `/inc:setup-deploy` once the channel model merges.
