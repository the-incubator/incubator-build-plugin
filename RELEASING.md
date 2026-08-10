# Releasing

This plugin ships on two channels so merged work gets real dogfooding before it reaches end users.

```
   feature PRs                            release (gated)
       │                                        │
       ▼                                        ▼
  ┌─────────┐   merge    ┌──────────┐  evals ✓ + QA ✓  ┌──────────┐
  │  PR      │──────────▶│  beta    │────────────────▶│  main     │
  └─────────┘            └────┬─────┘  scripts/        └────┬─────┘
                              │        release.sh           │
                    marketplace: incubator-beta    marketplace: incubator
                    every merge ships to testers   version-pinned; users move
                    immediately (commit SHA)       only when a release lands
```

## How the channels work

Claude Code decides whether a plugin has an update by looking at `version` in `.claude-plugin/plugin.json`.
If it is set, it is a pin: users only pull when the string changes.
If it is omitted, every new commit SHA counts as a new version.

The two branches exploit that:

| | `main` (stable) | `beta` |
|---|---|---|
| Marketplace name | `incubator` | `incubator-beta` |
| `version` in plugin.json | pinned semver, bumped per release | omitted — every merge auto-ships |
| Audience | end users | maintainers + internal testers |
| Code arrives | only via `scripts/release.sh` | on every PR merge |

The two channel files (`marketplace.json` name, `plugin.json` version) are the **only** intended difference between the branches.
`scripts/check-channel.mjs` enforces this in CI (`channel-guard.yml`) on every push and PR to either branch, so a plain `git merge beta` into main — which would rename the prod marketplace and unpin every stable user — fails before it lands.

The self-update hook (`hooks/plugin-update.mjs`) derives its channel from its own install path, so the same code updates stable installs from `incubator` and beta installs from `incubator-beta` with no per-branch edits.

## Day-to-day development

1. Branch from `beta`, open PRs against `beta` (the repo default branch).
2. CI on the PR: `validate-skills` + hooks tests + channel guard.
3. Merge. The change ships to everyone on the beta channel within about an hour (the plugin self-updates on session start/end) — dogfood it there.

## Joining the beta channel

```bash
scripts/toggle-local.sh claude beta
```

or manually:

```bash
claude plugin marketplace add the-incubator/incubator-build-plugin@beta
claude plugin install incubator-build@incubator-beta
```

Don't run both channels at once — two installs of the same plugin means duplicate skills and hooks (`toggle-local.sh` swaps cleanly between them).

## Cutting a release

1. Make sure beta has soaked: the changes you're promoting have been dogfooded by beta users.
2. Open a promotion PR `beta` → `main` (optional but recommended: this is where `evals.yml` runs the routing evals in CI, plus the channel guard).
3. From an up-to-date `main` checkout:

   ```bash
   scripts/release.sh 0.5.0            # runs evals locally too; --skip-evals if CI already did
   ```

   The script merges `origin/beta` without committing, restores main's channel files, writes the new version into both plugin manifests, runs the gates (channel guard, skill validation, hooks tests, routing evals), commits `release: v0.5.0`, tags `v0.5.0`, and asks before pushing.
   The push is the release — stable users' pinned version changes, and their installs pick it up on the next self-update cycle.

4. If users report a bad release, revert on main and cut a new release; the version pin means a revert + release ships as fast as a fix.

## The eval gate

`evals/run-routing.mjs` runs the routing fixtures in `evals/routing.yaml`: realistic user prompts that must invoke the expected skill, plus negative fixtures (`expect: none`) that must NOT trigger any of this plugin's skills.
Together they guard the trigger phrases in the skill descriptions — historically the most regression-prone part of the plugin — in both directions: under-triggering and over-triggering.
Where eval coverage goes next lives in [evals/ROADMAP.md](evals/ROADMAP.md).

- CI: `evals.yml` runs them on promotion PRs into `main`, on manual dispatch, and weekly (model/CLI updates can shift routing with no commit here).
  Auth comes from the `CLAUDE_CODE_OAUTH_TOKEN` repo secret (from `claude setup-token`) — billed to the Claude subscription, no API credits.
  A fresh CI runner has no other plugins installed, so these runs are authoritative even though OAuth tokens can't use `--bare`.
  `ANTHROPIC_API_KEY` works as an optional fallback (costs API credits, enables `--bare`); if both are set, the API key wins the CLI's auth chain.
- Local: `npm run test:evals` (your normal claude subscription auth, no API credits; but your other plugins also load and can steal routing, so treat local results as indicative).
  Export `ANTHROPIC_API_KEY` only if you want an authoritative `--bare` run locally.
- Failures write per-case streams to `evals/.artifacts/` with `--keep-logs` (uploaded as a CI artifact).

## One-time setup (already done, kept for reference)

- `scripts/cut-beta.sh` created the `beta` branch with its channel commit.
- GitHub default branch set to `beta` so PRs target it: `gh api -X PATCH repos/{owner}/{repo} -f default_branch=beta`.
- Eval-gate auth: ran `claude setup-token` locally and added the printed token as the `CLAUDE_CODE_OAUTH_TOKEN` repo Actions secret.
  The token is valid for one year — renew it (same two steps) when it expires.

## Known limitations

- The beta channel is Claude-only; Codex installs keep using the stable source.
- Claude Code's *background* marketplace auto-update has a known upstream bug (fetch without pull; anthropics/claude-code#35752). The plugin's own update hook runs the update explicitly, which avoids it, but if a tester seems stuck on an old beta, `claude plugin marketplace update incubator-beta` is the reliable manual path.
- `inc:update-code` still hardcodes `main` as the sync source; with `beta` as the integration branch it should learn to resolve the default branch (follow-up).
