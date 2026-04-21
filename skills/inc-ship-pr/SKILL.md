---
name: inc:ship-pr-7
description: Use when the user says "ship it", "ship this PR", "ship pr", "deploy check", "ready to deploy", "merge and deploy", or is about to merge a PR that triggers a production deploy. Runs four blocking checks (new env vars, Drizzle schema migrations and backward compatibility, data backfill / sports data sync prerequisites, deploy-window timing) and blocks the merge if any fail. Ends with a monitoring reminder.
allowed-tools: Read, Bash(git *), Bash(gh *), Bash(date *), Bash(TZ=* date *), Bash(npx drizzle-kit *), Bash(npm run *), Bash(./scripts/*), Glob, Grep
---

# Ship PR: Production Deploy Readiness Check

Four gates every PR must pass before it merges into a branch that deploys to production. Any failure **blocks the merge**. Merging a red gate is a ship-stopping violation, not a warning.

Report each gate in order. At the end, print a single line: `SHIP: GO` or `SHIP: BLOCK — <reasons>`. Then print the monitoring reminder.

---

## Gate 1: New Environment Variables

New `process.env.*` or `import.meta.env.*` references in the diff must already be configured in the Google Cloud Build deploy pipeline (`cloudbuild.yaml` substitutions for frontend `VITE_*` vars, Cloud Run environment for backend vars).

Run:

```bash
./scripts/check-env-vars.sh
```

Parse output:

- `STATUS: pass` → **Gate 1 OK.**
- `STATUS: warn` (new vars found) → **Gate 1 BLOCK.** List each new var from `NEW_VARS:`. For each, tell the user:
  > **New env var `<VAR_NAME>`** — not in `cloudbuild.yaml`.
  > - If `VITE_*`: add to `cloudbuild.yaml` substitutions and commit.
  > - Else: add to Cloud Run service env vars in the GCP console for the target environment.
  >
  > Merge is blocked until this var is configured in the deploy pipeline.

Do not proceed past this gate until the user confirms each new var is configured in the pipeline. "I'll add it after merge" is not acceptable — the var must exist when the new code runs.

---

## Gate 2: Database Schema Migrations

Schema changes must be managed through Drizzle and must be **backward compatible** with the currently-deployed code, because new code and old code run side-by-side during deploy.

**Step 2a — Detect schema changes in the diff:**

```bash
git diff origin/main -- '**/schema.ts' '**/drizzle/**' 2>/dev/null
```

If there is no schema diff and no new migration files → **Gate 2 OK.**

**Step 2b — Verify a Drizzle migration exists for the schema change:**

```bash
npm run db:validate 2>/dev/null || npx drizzle-kit check
```

If the schema changed but no migration file was generated → **Gate 2 BLOCK.** Tell the user:
> Schema changed in `schema.ts` but no Drizzle migration file was generated. Run `npx drizzle-kit generate --name <descriptive-name>` and commit the generated SQL before shipping.

Hand-written SQL migrations are not accepted unless specifically required (triggers, FK changes, backfills) — use `npm run db:custom-generate` for those and note it in the PR.

**Step 2c — Backward-compatibility review.** Read each new migration file and classify every statement:

| Statement | Safe? |
|-----------|-------|
| `ADD COLUMN` (nullable or with default) | Safe |
| `CREATE TABLE`, `CREATE INDEX CONCURRENTLY` | Safe |
| `ADD COLUMN NOT NULL` (no default) | **Breaks old code writes** |
| `DROP COLUMN`, `DROP TABLE` | **Breaks old code reads** |
| `RENAME COLUMN`, `RENAME TABLE` | **Breaks old code reads** |
| `ALTER COLUMN TYPE` (narrowing) | **Breaks old code** |
| `CREATE INDEX` (blocking, no CONCURRENTLY) | **Locks writes on large tables** |

If any statement is in the danger rows → **Gate 2 BLOCK.** Tell the user:
> Migration `<filename>` contains `<statement>`, which is not backward compatible. The old code running during deploy will break.
>
> **Safe pattern:** Split into two PRs.
> 1. First PR: deploy code that no longer reads/writes the column, plus an additive migration if needed.
> 2. Second PR (after first is live): the destructive migration.

If all statements are safe → **Gate 2 OK.** Summarize the migration in one sentence for the record.

---

## Gate 3: Data Backfill / Sports Data Sync Prerequisites

Some changes require data to be populated or re-synced **before** the new code runs — otherwise the first request after deploy hits empty or stale data. Examples:

- A new column that the new code reads assumes existing rows have been backfilled.
- A new feature reads from a sports data table that a sync job populates.
- A schema reshape (enum change, denormalization) requires a one-time data transform.

Search the diff for signals that a backfill or sync is required:

```bash
git diff origin/main | grep -iE 'backfill|sync[_-]?job|seed|populate|one[-_ ]time|migration[_-]?script'
```

Also scan for new queries that read columns introduced in this PR — those columns must have data.

Ask the user directly:
> **Gate 3:** Does this PR require a data backfill, seed, or sports data sync to run **before** deploy?
>
> - If **yes**: Has the backfill been run (staging or prod as applicable), and verified complete? If not, merge is blocked.
> - If **no**: Confirm, and we move on.

- User confirms "no, nothing required" → **Gate 3 OK.**
- User confirms backfill exists and has been run + verified → **Gate 3 OK.** Note what was run in the ship report.
- User confirms backfill required but not yet run → **Gate 3 BLOCK.** Tell them:
  > Run the backfill or sync first, verify its output, then re-run `/inc:ship-pr-7`.

Do not guess on this gate. Ask, even if the diff looks trivial.

---

## Gate 4: Deployment Window

Production deploys happen **after 1:00 PM Eastern, Monday through Thursday**. No Friday deploys. No pre-1PM deploys. No weekend deploys. The window exists so the team is available to respond if something breaks.

Check current EST time:

```bash
TZ='America/New_York' date +"%A %Y-%m-%d %H:%M %Z"
TZ='America/New_York' date +"%u %H"   # %u: 1=Mon..7=Sun, %H: 24-hour
```

Rules using the second command's output (`DOW HOUR`):

| Condition | Result |
|-----------|--------|
| DOW is 1, 2, 3, or 4 **and** HOUR >= 13 | **Gate 4 OK** (Mon–Thu, on/after 1PM EST) |
| DOW is 1, 2, 3, or 4 **and** HOUR < 13 | **Gate 4 BLOCK** — too early |
| DOW is 5 | **Gate 4 BLOCK** — Friday, no deploys |
| DOW is 6 or 7 | **Gate 4 BLOCK** — weekend, no deploys |

Do not override this gate on your own. If the user explicitly says something like "deploy anyway, this is a hotfix", require them to state that out loud — then note the override in the ship report. Never silently pass a bad window.

Blocked output:
> **Gate 4 BLOCK.** Current time: `<Mon 2026-04-20 11:42 EDT>`. Deploy window is Mon–Thu 1:00 PM EST onward. Wait until `<next valid window>` or get explicit override from the user.

---

## Final Report

After all four gates, print:

```
=== SHIP-PR REPORT ===
Gate 1 (env vars):       <OK | BLOCK: ...>
Gate 2 (migrations):     <OK | BLOCK: ...>
Gate 3 (backfill/sync):  <OK | BLOCK: ...>
Gate 4 (deploy window):  <OK | BLOCK: ...>

SHIP: <GO | BLOCK — gate(s) N, M>
```

If `SHIP: BLOCK`, stop. Do not merge. Do not suggest workarounds that skip a gate.

If `SHIP: GO`, tell the user they're clear to merge, then print the monitoring reminder below. To perform the merge itself, hand off to `git-merge-expert`.

---

## Monitoring Reminder (only on SHIP: GO)

After the user merges, they must actively watch the deploy. Print this verbatim:

> **You're clear to merge. Once merged, monitor the deploy in all three places until it's green:**
>
> 1. **Slack `#deploys` channel** — watch for the Cloud Build start/success/failure message for this commit.
> 2. **Slack `#errors` channel (and/or your monitoring tool — Sentry / Datadog / whichever is wired up)** — watch for a spike in new errors in the minutes after deploy.
> 3. **Hosting infrastructure** — Cloud Run service dashboard for the target environment: check instance health, request error rate, and CPU/memory for at least 10 minutes post-deploy.
>
> If any of the three goes red, roll back immediately rather than debugging live.

---

## What This Skill Does NOT Do

- Does not merge the PR. The user merges after the report says GO, or hands off to `git-merge-expert` to perform the merge.
- Does not run the deploy. Merging the PR triggers Cloud Build.
- Does not run the backfill. That is a manual prerequisite the user confirms.
- Does not replace code review or CI. Assume those already passed.
