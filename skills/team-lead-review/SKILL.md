---
name: inc:team-lead-review-6
description: Team lead PR review focused on product acceptance — did the author build what was actually requested? Accepts requirements from a spec doc, Slack message link, or board task (Asana/Linear/etc.) URL. Use when reviewing a teammate's PR for feature completeness, when re-reviewing after feedback, or when the user says "review PR", "check PR", "recheck", "did he finish", "acceptance review", "re-review", or provides a PR number/URL plus an optional requirements reference.
---

# Team Lead Review

Review a teammate's PR from a team lead perspective. The lead question is **"did they ship what was requested?"** Tech concerns are secondary — flag the risky stuff, but don't bury the product evaluation under nitpicks.

Two modes: **first review** and **re-review**.

Requirements can come from any of:
- A spec doc (Google Doc, Notion, README, local file, plain URL)
- A Slack message link (the original ask, often a thread)
- A board task (Asana, Linear, GitHub issue, Jira) — the source of truth for acceptance criteria
- The PR description itself, if nothing else is provided

## Parsing Arguments

Parse `$ARGUMENTS` to determine mode, the PR, and any requirements reference(s):

| Pattern | Mode | Example |
|---------|------|---------|
| `<PR>` | First review | `/inc:team-lead-review-6 3` |
| `<PR> <ref>` | First review with requirements | `/inc:team-lead-review-6 3 https://incubator.slack.com/archives/C0.../p17...` |
| `<PR> <ref1> <ref2>` | First review with multiple sources | `/inc:team-lead-review-6 3 <asana-url> <slack-url>` |
| `<PR> --recheck` | Re-review | `/inc:team-lead-review-6 3 --recheck` |
| `<URL>` | First review | `/inc:team-lead-review-6 https://github.com/.../pull/3` |

- `<PR>` can be a number or a full GitHub PR URL
- `<ref>` can be:
  - **Slack URL** — `slack.com/archives/{CHANNEL}/p{TS}` (with optional `?thread_ts=…`)
  - **Asana task URL** — `app.asana.com/0/{PROJECT}/{TASK}` or `app.asana.com/1/.../task/{TASK}`
  - **Linear URL** — `linear.app/{org}/issue/{ID}`
  - **GitHub issue URL** — `github.com/{owner}/{repo}/issues/{N}`
  - **Google Doc URL** — `docs.google.com/document/d/{DOC_ID}/...`
  - Any other URL (WebFetch) or local file path
- If `$ARGUMENTS` is empty, ask which PR to review and whether there's a Slack thread, board task, or spec the work came from
- If a PR is given but no requirements reference, look at the PR body for a linked task/Slack thread before falling back to "PR description is the spec"

---

## Mode 1: First Review

### Step 1: Gather Context

Fetch PR metadata and diff in parallel with the requirements source:

```bash
# PR metadata
gh pr view {PR} --json title,body,author,headRefName,baseRefName,url,additions,deletions,changedFiles

# Full diff
gh pr diff {PR}

# Changed files list
gh pr diff {PR} --name-only
```

**Pull the requirements** based on the reference type:

- **Slack message link** — Parse the channel ID and message timestamp from the URL (`/archives/{CHANNEL}/p{TIMESTAMP}` — convert `p1700000000123456` to `1700000000.123456`). Use `mcp__claude_ai_Slack__slack_read_thread` if it's a thread, otherwise `mcp__claude_ai_Slack__slack_read_channel` around that timestamp. Capture the originating ask plus any clarifying replies — the actual acceptance bar often lives in the follow-up messages.
- **Asana task URL** — Extract the task ID (the long numeric segment after `/task/` or as the trailing path segment). Use `mcp__claude_ai_Asana__get_task` and `mcp__claude_ai_Asana__get_attachments`. Read the description, custom fields, and comments — acceptance criteria, scope notes, and "do not do" lines often live in comments.
- **Linear URL** — Use WebFetch on the issue URL or search via available Linear tooling if installed. Capture the issue body and any comments.
- **GitHub issue URL** — `gh issue view {N} --json title,body,comments`
- **Google Doc URL** — `gws-docs` skill: `gws docs documents get --params documentId={DOC_ID}`
- **Other URL** — WebFetch
- **Local file** — Read it
- **Nothing provided** — Look at the PR body for a referenced task or Slack permalink. If you find one, fetch it. If not, use the PR description itself as the spec and note the missing source as a gap to flag in the report.

If multiple sources are provided, merge them: the board task is usually the canonical scope; Slack threads add real-time clarifications and reversals.

### Step 2: Extract Acceptance Criteria

Before evaluating the diff, write down — explicitly — the list of acceptance criteria. This is the spine of the review.

Prefer criteria phrased as user-observable outcomes ("user can X", "Y appears when Z"), not implementation directives. If the source only contains implementation notes, infer the underlying user-facing behavior and flag the ambiguity.

For each criterion, note:
- The source (which doc / Slack message / task field it came from)
- Whether it's a **must-have** (explicit ask) or **implied** (reasonable expectation given the ask)
- Whether it's testable from the UI/API or only by reading code

If the source is silent on an obviously important behavior (empty states, error cases, permissions), call that out as a **scope gap in the spec** — don't invent criteria the author was never told about, but surface the missing direction.

### Step 3: Product Acceptance — The Main Event

Walk each criterion against the diff. For each:
- Find the code change(s) that satisfy it (or fail to)
- Decide: **implemented**, **missing**, **deviates**, or **verify manually**
- For "deviates", describe what the spec said vs what was built — the author may have a good reason, but the lead needs to see the gap
- For "verify manually", give the exact thing to check (URL + action + expected result)

Be willing to say "I can't tell from the diff alone — needs to be tried in the preview." That's a valid status; it's honest.

### Step 4: Manual Testing Guide

Help the reviewer (you, or the human team lead) try it quickly:

1. Find the preview deployment:
```bash
gh pr view {PR} --json comments --jq '.comments[] | select(.body | test("vercel|preview|deploy")) | .body' | head -5
```

2. If no preview, give the local-checkout command:
```bash
git fetch origin {BRANCH} && git checkout {BRANCH} && pnpm dev
```

3. For each testable criterion, give a numbered step list: URL → action → expected outcome. Keep it tight enough that a human can run it in one sitting.

### Step 5: Risk-Targeted Tech Review

Product acceptance is primary; tech review is targeted, not exhaustive. Scan the diff and only deep-dive files that touch:

- Auth changes (stamps, headers, permissions, user identity)
- Smart contract interactions (addresses, ABIs, chain IDs, token handling)
- Payment or financial logic (prices, balances, transactions)
- Data mutations (state changes, API writes, database operations)
- New dependencies in `package.json`
- Complex state management (new contexts, reducers, cross-component state)
- Environment-specific logic (mainnet vs testnet, feature flags)

For each flagged area: is the logic correct? Are there edge cases? Could this break existing behavior? Skip style, naming, and minor patterns — those are not the team lead's job at this stage.

### Step 6: Output Report

```markdown
# PR Review: {PR title}
**PR:** {URL} | **Author:** {author} | **Branch:** {branch}
**Requirements source:** {Slack thread / Asana task / spec doc / PR description}

## Acceptance Criteria

| # | Criterion | Source | Status | Evidence / How to verify |
|---|-----------|--------|--------|--------------------------|
| 1 | {user-observable outcome} | {Asana / Slack / inferred} | {status} | {file:line, or manual step} |
| 2 | ... | ... | ... | ... |

Status key: implemented · missing · deviates · verify manually

## Spec Gaps

Things the spec didn't say but probably should have. Omit if none.

- {ambiguity or missing direction, and what assumption the author seems to have made}

## Manual Testing Guide

**Preview:** {Vercel preview URL or local dev instructions}

- [ ] **{Test flow 1}** — {steps, expected outcome}
- [ ] **{Test flow 2}** — {steps, expected outcome}

## Tech Concerns

Only include genuine concerns from the targeted review. Omit the section if the code looks sound.

- **{severity}** {file:line} — {what's wrong and why it matters}

## Action Items

Numbered list for the PR author, ranked by importance. Lead with product gaps, then tech concerns. Skip if everything looks good.

1. {Clear, actionable item}
2. ...
```

---

## Mode 2: Re-Review (`--recheck`)

### Step 1: Fetch Previous Feedback

```bash
# Reviews from humans
gh api repos/:owner/:repo/pulls/{PR}/reviews --jq '[.[] | select(.user.login != null and (.user.login | test("bot") | not)) | {user: .user.login, state: .state, submitted_at: .submitted_at, body: .body}]'

# Inline review comments
gh api repos/:owner/:repo/pulls/{PR}/comments --jq '[.[] | select(.user.login != null and (.user.login | test("bot") | not)) | {user: .user.login, body: .body, path: .path, line: .line, created_at: .created_at}]'

# Issue-level PR comments
gh api repos/:owner/:repo/issues/{PR}/comments --jq '[.[] | select(.user.login != null and (.user.login | test("bot") | not)) | {user: .user.login, body: .body, created_at: .created_at}]'
```

Identify the most recent human review timestamp — that's the "last review" boundary.

If the original requirements source is known (the user passed it again, or it's referenced in the PR body), pull it again so you can verify the re-review against acceptance criteria, not just against the previous comments.

### Step 2: Get the Delta

```bash
# Commits after the last review
gh api repos/:owner/:repo/pulls/{PR}/commits --jq '[.[] | select(.commit.committer.date > "{LAST_REVIEW_TIMESTAMP}") | {sha: .sha[:7], message: .commit.message, date: .commit.committer.date}]'

gh pr diff {PR}
```

If there are no new commits, report that nothing has changed and stop.

### Step 3: Map Feedback to Resolution

For each feedback item from the last review:
1. Summarize the original feedback
2. Find evidence in the new commits
3. Classify: **addressed** · **not addressed** · **partially addressed** · **addressed differently**

If you also have the original requirements source, re-evaluate any criteria that were previously **missing** or **deviates** — the new commits might have closed the gap.

### Step 4: Surface Surprises

Scan all changes in the new commits, not just the ones tied to feedback. Flag anything:
- Not requested in the previous round
- Touching files unrelated to the original feedback
- Adding new features or refactors beyond what was asked

For each, give a quick risk read: harmless cleanup · worth a look · concerning.

### Step 5: Output Report

```markdown
# Re-Review: {PR title}
**PR:** {URL} | **New commits since last review:** {count}

## Feedback Resolution

| # | Original Feedback | Status | Evidence |
|---|-------------------|--------|----------|
| 1 | "{feedback summary}" | {status} | {commit or file:line} |
| 2 | ... | ... | ... |

Status key: addressed · not addressed · partially addressed · addressed differently

## Acceptance Criteria Re-check

Only included if a requirements source is available. Show only criteria whose status changed since the previous review.

| # | Criterion | Was | Now | Evidence |
|---|-----------|-----|-----|----------|
| 1 | ... | missing | implemented | {file:line} |

## Unexpected Changes

Omit if none.

- **{file:line}** — {what changed, quick risk read}

## Verdict

One of:
- **Ready to merge** — All feedback addressed, no new concerns.
- **Almost there** — {N} item(s) remaining: {list them}.
- **Needs another round** — {what's still outstanding}.
```

---

## Guidance

- **Product over code.** The primary question is "did they build what was asked?" Tech concerns are secondary unless something is actually broken or risky.
- **Trust the source of truth.** If the Asana task says X and the implementation does Y, that's a product gap — even if Y is technically nicer. The author should either change the code or update the task with the explicit deviation reason.
- **Slack threads carry hidden requirements.** The original message is the headline; the replies are usually where scope was clarified, narrowed, or quietly expanded. Read the whole thread.
- **Be specific.** Don't say "this looks off" — say what's wrong and what would make it right.
- **Respect the author.** Frame feedback as questions or suggestions, not commands. They often have context you don't.
- **Keep action items minimal.** 3 clear items beats 15 nitpicks. Optimize for "what does this PR need to ship?"
- **Re-review should be fast.** Don't re-review the entire PR — only the delta and the previously-failing criteria.
- **Don't scope creep.** Review what was submitted against what was asked. Don't suggest new features or redesigns unless something is genuinely broken or unsafe.
- **Name the spec gaps.** If the requirements source was ambiguous, say so. The fix may be on the spec side, not the code side.
