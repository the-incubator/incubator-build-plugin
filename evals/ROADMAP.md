# Eval testing roadmap

Where eval coverage for this plugin stands and what to chew through next, roughly in value-per-effort order.
Guiding rule: evals gate releases (beta → main), cheap deterministic tests gate every PR, and new coverage gets added when a real regression bites — not speculatively.

## Shipped

- **Structural gates, every PR** — `validate-skills` (frontmatter lint), hooks unit tests, channel-invariant guard.
- **Positive routing evals** — realistic prompt → expected skill (`routing.yaml`), best-of-N attempts, gate on promotion PRs into main plus a weekly drift check (`evals.yml`).
- **Negative routing evals** — `expect: none` prompts that must NOT trigger any of this plugin's skills. Guards over-triggering, the regression trigger-broadening PRs actually introduce. Strict: one false trigger fails the case, no retry-to-pass.

## Next up

### 1. Per-skill positive coverage
Every user-invocable skill gets at least one positive fixture; today ~11 of 21 skills are covered.
Mechanical work: pull the strongest trigger phrase from each remaining skill's description into `routing.yaml`.
Do this before the fixture set calcifies around the popular skills.

### 2. Incident-driven static contract tests (the compound-engineering pattern)
When a skill regression bites in the wild — a trigger phrase lost in an edit, a gate instruction reworded into ineffectiveness — pin it with a cheap text-assertion test (`node --test`, runs on every PR to beta).
Zero tokens, zero flake, permanent institutional memory.
Convention: `tests/<skill>-<incident>.test.mjs` with a comment linking the incident/PR.
Don't write these speculatively; each one must trace to a real failure.

### 3. Pass-rate reporting for the weekly drift run
Binary pass/fail hides slow degradation (a case sliding from 100% to 60% routing reliability still passes best-of-3).
Add a `--trials N` mode to the runner that reports per-case pass rates and fails below a threshold, and use it only in the weekly scheduled run where wall-clock and tokens matter less.
Pattern borrowed from skillgrade's `--smoke/--reliable/--regression` presets (5/15/30 trials).

### 4. Negative-fixture growth
Grow `expect: none` cases from real over-trigger reports (beta users are the detector).
Candidate sources: prompts that summoned `inc:debug` on non-failures, `inc:guide` on non-plugin questions.
Same rule as contract tests: each fixture traces to a real incident.

## Later / conditional

### 5. Per-skill task-completion evals — use skillgrade, don't hand-roll
When routing isn't the question but "did the skill DO the right thing" is (candidates: `inc:merge-pr` gates, `release.sh` behavior), adopt [mgechev/skillgrade](https://github.com/mgechev/skillgrade): Docker-sandboxed tasks, weighted deterministic + LLM-rubric graders, trials → pass-rate threshold, CI mode.
Precondition: verify its containerized Claude agent honors `CLAUDE_CODE_OAUTH_TOKEN` (subscription billing — we don't spend API credits).
Trigger for doing this at all: the same skill regresses behaviorally twice despite beta dogfooding.

### 6. Guardrail evals
Live headless assertions that the safety hooks hold: e.g. a session instructed to `gh pr create` gets blocked by `gh-pr-gate`.
The hook logic already has unit tests; this tier only pays off if a guardrail ever fails in integration despite green unit tests.

### Non-goals
- Evals on every feature PR (cost + flake; that's what the beta channel and structural gates are for).
- Grading answer *quality* of skills whose output is prose (subjective; human dogfooding covers it).
- Chasing 100% routing reliability on ambiguous phrasings — widen `expect` lists instead.
