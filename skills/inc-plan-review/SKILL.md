---
name: inc:plan-review
description: Review a plan, spec, or design proposal *before* implementation. Dispatches inc-staff-reviewer alongside plan-adapted personas to surface gaps, over-engineering, risk, and ambiguity.
argument-hint: "[path to plan file, URL to plan doc, or blank to review the most recently modified plan in docs/plans]"
allowed-tools: Bash(ls:*), Bash(find:*), Bash(cat:*), Bash(wc:*), Bash(git log:*), Bash(git status:*), Bash(git rev-parse:*)
disable-model-invocation: false
---

Review a plan or design proposal **before** any implementation begins. The goal is to catch missing edge cases, unnecessary complexity, ambiguous requirements, and architectural risk while changes are still cheap.

## When to use

- A PRD, design doc, or technical plan is ready and you want a skeptical pass before writing code
- You have a brainstorm or spec and need it stress-tested
- You want structured gating between planning and implementation

Do **not** use this to review code changes — use `/inc:review` or `/inc:review-deep` for that.

## Mode detection

- **Path mode** — `$ARGUMENTS` is a filesystem path to a markdown file. Read it directly.
- **URL mode** — `$ARGUMENTS` looks like a URL. Fetch its contents via WebFetch.
- **Auto mode** — `$ARGUMENTS` is empty. Pick the most recently modified file under `docs/plans/` (fall back to the repo root if that directory does not exist). If nothing plausible exists, stop with `No plan found. Pass a path or URL to /inc:plan-review.`

In every step below, "the plan" means the resolved plan document content.

## Steps

Follow these steps precisely:

1. **Resolve the plan.** Using the mode above, obtain the plan document contents. Confirm the path or URL to the user in one line before proceeding (e.g. `Reviewing: docs/plans/2026-04-20-feat-foo.md (312 lines)`).

2. **Summarize the plan.** Use a Haiku agent to produce a ~150-word summary covering: the problem being solved, the proposed approach, key architectural decisions, and any explicit non-goals or open questions. This summary gets passed to every reviewer below so they share a common baseline.

3. **Dispatch 5 parallel Sonnet reviewers.** Each receives the full plan text and the summary from step 2. Each must return a list of concrete issues with a short rationale.

   a. **Agent #1 — Staff reviewer (primary).** Dispatch the `inc-staff-reviewer` subagent (defined at `agents/inc-staff-reviewer.agent.md`). Ask it to surface:
      - Missing edge cases or error scenarios
      - Over-engineering (is the simplest approach being used?)
      - Unclear requirements or ambiguous specs
      - Scalability or performance concerns
      - Security implications
      - Missing or inadequate verification strategy (tests, type checks, manual QA)
      - Dependencies or ordering issues

      Expect its final verdict token (`APPROVE` / `REQUEST CHANGES` / `NEEDS RETHINK`) — capture it for the summary block in step 6.

   b. **Agent #2 — Architecture strategist.** Dispatch the `inc-architecture-strategist` subagent (`agents/review/inc-architecture-strategist.agent.md`). Reframe its job for the plan stage: evaluate proposed component boundaries, coupling/cohesion of the described design, potential SOLID violations that the plan is baking in, API or contract stability, and whether the proposed structure will introduce leaky abstractions or circular dependencies once implemented. Skip file-level code analysis — reason over the plan's described architecture only.

   c. **Agent #3 — Adversarial reviewer.** Dispatch the `inc-adversarial-reviewer` subagent (`agents/review/inc-adversarial-reviewer.agent.md`). Reframe: construct concrete failure scenarios the plan does not address. For each scenario, describe the trigger sequence, the expected-but-unspecified behavior, and the blast radius. Prioritize scenarios in high-risk domains (auth, payments, data mutations, external APIs, migrations) if the plan touches them.

   d. **Agent #4 — Security sentinel.** Dispatch the `inc-security-sentinel` subagent (`agents/review/inc-security-sentinel.agent.md`). Reframe for plan-level: evaluate auth/authz assumptions, data-exposure risks, API surface, secret handling, and OWASP-relevant threat model elements that the plan either hand-waves or omits. Call out gaps, not speculative vulnerabilities in unwritten code.

   e. **Agent #5 — Simplicity reviewer.** Dispatch the `inc-code-simplicity-reviewer` subagent (`agents/review/inc-code-simplicity-reviewer.agent.md`). Reframe for plan-level: identify YAGNI violations, premature abstractions, speculative flexibility, unnecessary new infrastructure, or scope that exceeds the stated goal. Suggest the smallest viable version.

4. **Confidence-gate findings.** For each issue returned in step 3, launch a parallel Haiku agent that scores the issue 0-100 on whether it is a real concern vs. a false positive, using this rubric verbatim:
   - **0** — Not a real issue. Doesn't stand up to light scrutiny, or already addressed in the plan text the reviewer missed.
   - **25** — Somewhat confident. Might be a real issue, might not. Not clearly grounded in the plan.
   - **50** — Moderately confident. Real concern but nitpicky or unlikely in practice relative to the overall plan scope.
   - **75** — Highly confident. Verified against the plan; will materially impact the implementation if unaddressed.
   - **100** — Certain. The plan explicitly contains the gap, and the consequence is unambiguous.

   Give the Haiku agent the issue description, the plan summary, and the relevant excerpt from the plan (if the reviewer cited one).

5. **Filter.** Drop any issue scoring below 70. Deduplicate near-identical findings across reviewers (prefer the more specific phrasing). If nothing remains, proceed to step 6 with an empty findings list.

6. **Print the report.** Output directly to the terminal — do not post to GitHub, do not edit files. Follow this format precisely:

   ---

   ### Plan review

   **Plan:** `<path or URL>`
   **Staff verdict:** `APPROVE` | `REQUEST CHANGES` | `NEEDS RETHINK`

   Found N issues:

   1. **<brief title>** — <one-sentence description of the problem>
      - *Risk:* <what breaks or gets harder if this is not addressed>
      - *Suggested fix:* <concrete change to the plan>
      - *Source:* <reviewer name>
      - *Reference:* `<plan-file>:L<start>-L<end>` (if the reviewer cited a specific section)

   2. ...

   ---

   If no issues survive the filter, emit:

   ---

   ### Plan review

   **Plan:** `<path or URL>`
   **Staff verdict:** `APPROVE`

   No blocking issues found. Plan looks solid to move into implementation.

   ---

## Notes

- Keep output brief. Aim for issues that a reviewer would genuinely block on.
- Do not invent problems. If a reviewer has nothing to add, its section simply contributes zero findings.
- Do not rewrite the plan. Surface issues; the human decides whether and how to revise.
- If the plan explicitly marks a concern as out-of-scope or a known non-goal, don't re-raise it.
- If every reviewer returns `APPROVE`-equivalent output and no issue clears the confidence gate, the overall verdict is `APPROVE` — say so and stop.

## Examples of false positives to drop in step 4

- Concerns that are addressed elsewhere in the plan and the reviewer missed the section
- Speculative future scaling concerns for a plan that's explicitly scoped to an MVP
- Pedantic wording suggestions that don't change the design
- Code-level nits inferred from a plan that hasn't specified implementation detail
- Security concerns about scenarios the plan explicitly defers to a follow-up
