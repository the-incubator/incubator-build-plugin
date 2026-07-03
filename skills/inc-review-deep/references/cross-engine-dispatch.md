# Cross-Engine Dispatch

How to run reviewer sub-agents on a different AI engine than the host platform.
Read this only when the resolved review engine differs from the host (see the Review Engine section of the skill).
When host and engine match, ignore this file entirely and use the native sub-agent mechanism.

## Principles

- **Same prompt, different transport.** Each reviewer receives exactly the content described in Stage 4 (persona file content, diff-scope rules, output contract, PR context, review context). Only the delivery mechanism changes: a subprocess of the engine CLI instead of a native sub-agent call.
- **Read-only sandbox, orchestrator writes artifacts.** Cross-engine reviewers run in the engine's read-only mode and cannot write files. They return the FULL findings JSON (all schema fields) as their final message. The orchestrator writes that JSON to `.context/incubator/inc-review/{run_id}/{reviewer_name}.json` and derives the compact merge-tier fields itself. This inverts the native contract, where the sub-agent writes its own artifact and returns compact JSON.
- **Everything downstream is engine-agnostic.** Stage 5 validation, merge, dedup, and Stage 6 synthesis consume the same JSON regardless of which engine produced it.
- **The fixer never crosses engines.** The After Review fixer sub-agent mutates the working tree and always runs natively on the host platform.

## Preflight

Before dispatching, verify the engine CLI is available:

```bash
command -v codex   # or: command -v claude
```

If the CLI is missing, fall back to native dispatch on the host platform and record the fallback in the Coverage section of the report.
A working review on the host engine is better than a broken dispatch.
If the CLI exists but every subprocess fails (for example, not logged in), the existing failed-reviewer and degraded-review paths apply.

## Prompt assembly

Build each reviewer's prompt from the Stage 4 subagent template with ONE substitution.
Replace the two-output contract (artifact file write + compact return) with this single-output contract:

> Return exactly one JSON object as your final message and nothing else.
> The object must contain ALL schema fields: reviewer, findings (with title, severity, file, line, why_it_matters, autofix_class, owner, requires_verification, confidence, evidence, pre_existing, and suggested_fix as a string or null), residual_risks, and testing_gaps.
> Do not write any files. Do not wrap the JSON in Markdown.

Everything else in the template (persona content, scope rules, confidence anchors, false-positive suppression, review context) is unchanged.
Write each assembled prompt to a temp file. Diffs can exceed argv limits, so never pass the prompt as a command-line argument.

Also write the findings schema to a temp file for `--output-schema`.
Use `references/findings-schema.strict.json`, NOT the canonical `findings-schema.json`.
Engine structured-output enforcement (OpenAI strict mode behind `codex exec --output-schema`) rejects schemas without `additionalProperties: false` on every object and with optional properties.
The strict variant is the same schema reshaped to satisfy those rules, with `suggested_fix` required-but-nullable.

```bash
WORK_DIR=$(mktemp -d)
# write references/findings-schema.strict.json content to "$WORK_DIR/schema.json"
# write each reviewer's assembled prompt to "$WORK_DIR/<reviewer_name>.prompt.md"
```

## Runner: codex engine (host is Claude Code or another non-Codex platform)

One subprocess per selected reviewer:

```bash
codex --ask-for-approval never exec \
  --ephemeral \
  -C "$(git rev-parse --show-toplevel)" \
  -s read-only \
  --output-schema "$WORK_DIR/schema.json" \
  --output-last-message "$WORK_DIR/<reviewer_name>.out.json" \
  - < "$WORK_DIR/<reviewer_name>.prompt.md"
```

Notes:

- `-s read-only` plus `--ask-for-approval never` runs fully unattended with no mutation risk.
- `--output-schema` enforces the findings schema at the engine level, so malformed returns are rare.
- `--output-last-message` writes the reviewer's final JSON to a file the orchestrator reads back.
- Omit `--model`. Let the user's configured Codex default apply. Only pass `--model` when the user explicitly named one.

## Runner: claude engine (host is Codex or another non-Claude platform)

One subprocess per selected reviewer:

```bash
claude --print --no-session-persistence \
  --output-format json \
  --json-schema "$(cat "$WORK_DIR/schema.json")" \
  --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git blame:*),Bash(gh pr view:*)" \
  < "$WORK_DIR/<reviewer_name>.prompt.md" > "$WORK_DIR/<reviewer_name>.out.json"
```

Notes:

- `--print` with `--output-format json` emits a JSON envelope on stdout. Extract the reviewer's findings object from the envelope's result field before validating.
- The `--allowedTools` list grants read-only inspection consistent with the native reviewers' non-mutating contract.
- Omit `--model` by default, same rule as the codex runner. `--model sonnet` is a reasonable mid-tier override when the user asks for cost control.

## CE agents (unstructured output)

CE agents (inc-agent-native-reviewer, inc-learnings-researcher, inc-schema-drift-detector, inc-deployment-verification-agent) dispatch through the same runner with two differences:

- Drop `--output-schema` / `--json-schema`. Their output is free-form text, synthesized separately in Stage 6.
- Their prompt is the agent definition content plus the same review context bundle native dispatch gives them.

## Parallelism and patience

- Launch all reviewer subprocesses concurrently as background shell tasks, one per reviewer, then collect outputs as they finish. If the host cannot run background tasks, run them sequentially per the skill's Fallback section.
- Engine subprocesses are slow and quiet. A reviewer on a large diff can legitimately take 10 or more minutes with no output. Do not kill a subprocess for being quiet.
- Treat a reviewer as failed only when its process exits nonzero or its output file is missing or unparseable after exit. Failed reviewers flow into the existing Coverage reporting. Do not retry more than once.

## Collect and continue

For each completed reviewer:

1. Read the output file and parse the full findings JSON (unwrapping the CLI envelope for the claude engine).
2. Write the full JSON to `.context/incubator/inc-review/{run_id}/{reviewer_name}.json` (skip in report-only mode, which generates no artifacts).
3. Derive the compact merge-tier view (title, severity, file, line, confidence, autofix_class, owner, requires_verification, pre_existing, suggested_fix) and feed it into Stage 5 exactly as if a native sub-agent had returned it.
