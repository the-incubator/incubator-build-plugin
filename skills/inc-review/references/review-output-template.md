# Code Review Output Template

> Adapted from inc-review-deep and kept loosely in sync by hand. The lightweight tier intentionally omits confidence scores and reviewer/persona provenance, so those sections diverge from the deep copy on purpose.

Use this shape when presenting synthesized review findings in interactive mode. **Lead with the decision; default to prose.** Findings the user must act on are explained in sentences, not crushed into table cells. Reviewer names and raw `autofix_class -> owner` route tokens are internal bookkeeping — they live in the on-disk run artifact, never on the terminal surface.

`mode:headless` uses a different, machine-facing envelope (see the end of this file).

## Example

```markdown
Review complete. Risk: low. Two findings are informational; one needs your call — it's a product decision that's yours to make, so I'm stopping there rather than deciding for you.

**Scope:** merge-base with the review base branch → working tree (14 files, 342 lines)
**Intent:** Add order export endpoint with CSV and JSON format support

## ⚠️ Needs your call — ownership check on export lookup

`orders_controller.rb:42`

The export action looks up an account by a user-supplied ID with no ownership guard, so any authenticated user can export another account's orders by changing the ID in the request. The endpoint is new and public, which makes this reachable in normal use.

In short: add a `current_user.owns?(account)` check before the lookup — but it changes access behavior, so it's your call rather than an automatic fix.

## Auto-applied

- `export_service.rb:45` — added error handling for CSV serialization failure, with test coverage.

## ℹ️ Informational (no action needed, shown for context)

- `export_service.rb:91` — no pagination; response size grows with order count. Acceptable for current volumes; revisit if accounts get large.
- `export_helper.rb:12` — format detection could use an early return instead of a nested conditional. Cosmetic.

### Coverage

- Residual risks: no rate limiting on the export endpoint.
- Testing gaps: no test for concurrent export requests.

---

> **Verdict:** Ready with fixes
>
> **Reasoning:** The auth gap on the export lookup is the one thing blocking merge and it's yours to decide. The pagination and cosmetic items are safe to follow up.
```

## Many findings — the long-tail table

The needs-your-call section always stays prose. When the report carries more than ~8 findings total, render only the **informational long tail** (and any P2/P3 the user isn't being asked to decide) as one compact table so it stays scannable:

```markdown
## ℹ️ Informational (no action needed, shown for context)

| # | File | Issue |
|---|------|-------|
| 1 | `export_service.rb:91` | No pagination; response grows with order count |
| 2 | `export_helper.rb:12` | Nested conditional could be an early return |
```

## Anti-patterns

Do NOT do these:

- **Leading with metadata.** Scope/intent/reviewer headers before the reader knows the risk level and what needs them. The situation summary comes first.
- **Findings as table rows when there are only a few.** A `| # | File | Issue | Reviewer | Route |` table crushes a finding's reasoning into a cell that wraps badly in a terminal. Explain it in prose.
- **Leaking provenance onto the surface.** Reviewer names (`security, correctness`) and raw route tokens (`ask_user -> human`) belong in the artifact, not the report. Surface the route as human framing: "needs your call", "auto-applied", "informational".
- **Box-drawing characters or per-finding horizontal-rule separators.** The only `---` rule in the report is the one before the verdict blockquote.

## Formatting rules

- **Situation summary first** — one or two sentences: risk level, count needing the user's decision, what was auto-applied/informational, and what's the user's call.
- **Needs-your-call findings as prose** — heading, `file:line`, a paragraph on what's wrong and why, a one-line direction, and an "In short:" restatement when long. Always include `file:line`.
- **Auto-applied** — bullet list, one line per fix; include only when a fix phase ran this invocation.
- **Informational** — demoted bullet list with one-line explanations; compact `| # | File | Issue |` table only past the ~8-finding volume threshold.
- **Pre-existing** — separate short bullet list; does not count toward the verdict.
- **CE sections** (Requirements Completeness, Learnings & Past Solutions, Agent-Native Gaps, Schema Drift Check, Deployment Notes) — include per the Stage 6 rules; bullet lists, omit when empty or not run.
- **Coverage** — residual risks, testing gaps.
- **Verdict in a blockquote** after a `---` rule: Ready to merge / Ready with fixes / Not ready, with reasoning and fix order.
- **No time estimates.**

## Headless Mode Format

In `mode:headless`, replace the interactive report with a structured text envelope. The headless format is defined in the `### Headless output format` section of SKILL.md. Key differences:

- Findings use `[severity][autofix_class -> owner] File: <file:line> -- <title>` line format with indented Why/Evidence/Suggested fix lines — this is the one machine-facing surface where the route token and evidence are intentionally included.
- Findings grouped by autofix_class (ask_user, fyi). Within each group, sorted by severity.
- Verdict in the header (top) so programmatic callers get it first.
- `Artifact:` line gives callers the path to the full run artifact.
- `[needs-verification]` marker on findings where `requires_verification: true`.
- Completion signal: "Review complete" as the final line.
