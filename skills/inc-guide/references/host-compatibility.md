# Host compatibility and composition

## Resolve the installed corpus

`skills/` at the plugin root is the only shared skill corpus.
Resolve the real filesystem path of the loaded `SKILL.md` first (follow symlinks), then go two directories above its containing skill directory to get the plugin root.
Do not search the user's project for plugin assets or assume the current working directory is the install root.
`CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT` may supply that same root on hosts that set them; other hosts need neither variable.
Keep shell commands operating on the user's project, and use absolute plugin paths only for bundled scripts and references.

Read relative Markdown links, `references/...`, and `@./references/...` explicitly with the host's file reader.
The `@` form is an inclusion hint, not a guarantee that the host loaded the file.
Read the complete referenced file before following instructions that depend on it.
Arguments mean the user's invocation text or the explicit arguments supplied by a calling workflow; `$ARGUMENTS` is only a Claude-style spelling, not a required shell variable.

## Follow sibling skills without a Skill tool

Use a native skill invocation tool when available.
Otherwise read the sibling's complete `SKILL.md` from the same installed corpus, follow it inline, then return to the caller's next step only after its required completion condition.
Do not simulate a nonexistent Skill tool, ask the user to run every child manually, or replace a child workflow with a summary.
Pass through explicit arguments (especially `--auto`, review mode, diff base, PR identity, and plan path).
A child skill's stop, failure, missing capability, permission denial, or unresolved decision stops the parent too.
Loading prose never authorizes bypassing a hook or claiming a gate passed.

| Workflow name | File relative to plugin root |
| --- | --- |
| `inc-review-and-pr` | [skills/inc-review-and-pr/SKILL.md](../../inc-review-and-pr/SKILL.md) |
| `inc-review` | [skills/inc-review/SKILL.md](../../inc-review/SKILL.md) |
| `inc-review-deep` | [skills/inc-review-deep/SKILL.md](../../inc-review-deep/SKILL.md) |
| `inc-commit-push-pr` | [skills/inc-commit-push-pr/SKILL.md](../../inc-commit-push-pr/SKILL.md) |
| `inc-resolve-pr-feedback` | [skills/inc-resolve-pr-feedback/SKILL.md](../../inc-resolve-pr-feedback/SKILL.md) |
| `inc-merge-pr` | [skills/inc-merge-pr/SKILL.md](../../inc-merge-pr/SKILL.md) |
| `inc-ship-it` | [skills/inc-ship-it/SKILL.md](../../inc-ship-it/SKILL.md) |
| `inc-update-code` | [skills/inc-update-code/SKILL.md](../../inc-update-code/SKILL.md) |
| `git-merge-expert` | [skills/git-merge-expert/SKILL.md](../../git-merge-expert/SKILL.md) |
| `inc-setup-deploy` | [skills/inc-setup-deploy/SKILL.md](../../inc-setup-deploy/SKILL.md) |
| `pr-description` | [skills/pr-description/SKILL.md](../../pr-description/SKILL.md) |

For other names, read the frontmatter of `skills/*/SKILL.md` in this installation.
Names intentionally retain the existing `inc:*` API and numbered stages; directory names are not always invocation names.
Hosts with strict Agent Skills naming can reject colons or name/directory mismatches.
Use the explicit file-reading path in that case, and report the discovery limitation rather than inventing a registered command.

## Personas and independent review

Persona definitions are portable prompt assets under the plugin-root [agents directory](../../../agents/), not a requirement to register Claude custom agents.
Resolve `review:<name>` to `agents/review/<name>.agent.md`, `research:<name>` to `agents/research/<name>.agent.md`, and an unqualified name to `agents/<name>.agent.md` (or the explicitly named `.md` file).
Read the persona and pass its body plus task context to a general-purpose subagent when the host lacks that registered agent name.
Use only tools, model IDs, and permission settings supported by the current host.
Model labels such as Sonnet or Haiku are preferences, not prerequisites: inherit the current model when an equivalent is unavailable.

Parallel dispatch may become sequential independent subagent calls when the host lacks parallelism.
If the workflow requires independent agents but there is no subagent mechanism, stop with a capability gap before review or mutation; do not grade your own work and call it an independent review.
Pi's bundled adapter only discovers skills, not subagents.
For Pi, a compatible subagent extension (for example `pi install npm:pi-subagents`) is required for reviewer/resolver fan-out; pass persona content to its general-purpose agent rather than assuming it discovers this package's `agents/`.

## Questions, tools, and limits

Use the host's native blocking question tool when present.
Otherwise ask inline, explicitly say `Waiting for your answer`, and stop until the user replies.
Silence is never consent, including in a parent workflow.
Tool names in legacy `allowed-tools` frontmatter are permission hints for supporting hosts, not instructions to fabricate unavailable tools or weaken permissions.
Use the equivalent host-native file, shell, web, and task-list tools when allowed.
Missing required credentials, CLIs, browser drivers, or remote services remain real blockers.

Hooks, telemetry, and automatic marketplace updates are supported only on the documented Claude/Codex paths.
Other adapters provide content discovery and invocation, not host-specific PR-gate parity.
If another host imports Claude-compatible hooks, leave those unsupported hooks disabled through the host's controls; use a skills-only link/configuration path if hooks cannot be disabled separately.
If an existing Codex PR gate cannot recognize a file-based activation, stop and report it; do not disable the gate or fabricate transcript evidence.
See the plugin-root README for the host matrix and follow-up boundaries.
