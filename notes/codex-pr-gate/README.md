# Codex PR gate diagnosis and delivery evidence

The source fix recognizes a real Codex skill load through host-written content metadata and checks the owning session and activation turn.
It reads the current workflow name from the skill frontmatter and retains the intentional `inc-commit-push-pr` legacy alias in `hooks/pr-workflow-skill.mjs`.
Claude activation recognition and all PR-creation detection channels remain supported.

## Capture limitation requiring firstmate's decision

The saved activation and denial are sanitized records from a genuine historical Codex PR-shipping attempt.
The exact historical hook stdin was not retained in that transcript or the inspected runtime logs.
`reconstructed-hook-input.json` is reconstructed from the recorded command and the installed-version source serializer, not a captured stdin payload.
No claim of a fresh installed-runtime PR attempt or fresh PR-skill activation is made.
The brief expressly prohibited both actions, so neither was performed.
The task's requirement for a raw installed-runtime stdin capture remains outstanding.
Firstmate must supply that capture from an authorized diagnostic session, or explicitly accept the historical transcript plus source-backed reconstruction before treating delivery as complete.
The plugin cache was only read and executed as an unchanged gate process; it was never edited.

## Trigger, masking condition, and symptom

- Initiating trigger: a Codex session attempted `gh-axi pr create` after the host injected the selected PR-shipping skill.
- Masking condition: the gate looked only for Claude `message.content[].tool_use` blocks named `Skill`, and its `inc-commit-push-pr` constant did not match the current frontmatter name `inc:commit-push-pr-4`.
- Visible symptom: the gate denied the command and told the Codex caller to invoke the Claude `Skill` tool.

The recorded Codex attempt used CLI 0.150.1 and plugin 0.6.0 on September 3, 2026.
The selected-skill record precedes the attempted command and denial in that same session.
The record positions were 1 for session metadata, 2 for turn start, 13 for the completed user-message event, 14 for the injected skill, and 56-57 for the command and denial.
Only the relevant structural records were retained, with identifiers consistently replaced and private content removed.
`captured-denial.txt` contains the original denial wording with the private command suffix removed.

Installed CLI 0.153.4 was verified during this task.
A September 10 capture from that version shows the same selected-skill metadata for the unrelated `handoff` skill, retained in `codex-0.153.4-unrelated-skill.jsonl`.
That record corroborates the current metadata shape; it is deliberately not represented as a current PR-skill activation.
The installed plugin cache is version 0.12.0, and its gate was byte-identical to the gate on source `main` before editing.
Latest source `main` was verified as `40bdff2`, plugin version 0.18.0.

## Host comparison and trust boundary

Claude emits an assistant message containing a structured `tool_use` block with `name: "Skill"` and `input.skill`.
`claude-activation.jsonl` is a sanitized genuine legacy activation, and the suite replays it through the fixed gate.
The original Claude legacy path was already accepted; the fix also accepts the current frontmatter identity.

Codex emits a `response_item` whose payload is a user `message` containing an `input_text` skill fragment.
Its `internal_chat_message_metadata_passthrough.content_item_kinds` marks that content block as `skills.selected_skill_instructions`.
The actual user request in the historical session instead has `user.text` metadata.
The adapter requires the host marker on the exact content block, a complete skill wrapper with the expected name, and a preceding completed `UserMessage` event that binds the fragment's turn ID to the hook's session ID.
The first `session_meta.id` must also equal the hook's `session_id`; an additional `session_meta.session_id`, when present, must agree.
Codex can retain parent history in forked rollouts, so checking only the file header is insufficient.
Inherited parent events do not authorize the child session, and activation from an earlier turn in the same session remains valid.

Plain mentions, exact XML pastes classified as user text, unrelated skills, tool outputs, and reading `SKILL.md` are not activation evidence.
No transcript was edited, hidden, or replaced in the operator runtime.
Only sanitized replay fixtures were written in this worktree.
The gate trusts host-owned structural transcript fields just as the previous Claude path trusted structural tool events; it is not a defense against an operator rewriting the transcript itself.

The installed-version source checkout confirms these boundaries:

- `codex-rs/ext/skills/src/fragments.rs`: `SkillInstructions.content_kind()` assigns `skills.selected_skill_instructions`.
- `codex-rs/context-fragments/src/fragment.rs`: the fragment renderer carries content classification into the response item.
- `codex-rs/hooks/src/schema.rs`: `PreToolUseCommandInput` includes session ID, turn ID, transcript path, tool name, input, and tool-use ID.
- `codex-rs/hooks/src/events/pre_tool_use.rs`: `command_input_json()` serializes the hook stdin and preserves the request tool name.
- `codex-rs/core/src/tools/hook_names.rs`: shell tools normalize to `Bash`.
- `codex-rs/rollout/src/recorder.rs`: the first session metadata record owns the rollout, while later metadata can come from fork history.

## History and original intent

`git blame` attributes the original Claude-only parser and legacy constant to initial commit `cce4ed9`.
The initial skill frontmatter already used `inc:commit-push-pr`, while the gate matched the historical directory/tool spelling.
Commit `2f3a5d0` changed the frontmatter to `inc:commit-push-pr-4` while numbering workflow steps; it did not update the gate.
Commit `3668416` expanded creation detection across CLI, REST, GraphQL, and MCP to prevent alternate-tool bypasses.
Commit `d10b7b7` intentionally made transcript-off sessions advisory.
These policies are retained.

## Failure behavior

An absent or nonexistent transcript path still allows the call without activation evidence.
An existing but unreadable transcript still denies because activation cannot be established.
A readable transcript with no qualifying activation, including malformed or empty content, denies.
Malformed stdin and unexpected exceptions still exit zero without a denial, preserving the existing fail-open policy.
Identity loading happens inside the main error boundary, so an unexpected frontmatter/filesystem failure follows that same policy.
Read-only commands and writes to PR sub-resources remain unaffected.

Codex denials now give the current skill name with the native dollar-prefix syntax.
Claude denials retain the `Skill` tool instruction using that same frontmatter name.

## Validation and smoke replay

Run the existing suite with `node --test hooks/gh-pr-gate.test.mjs`.
The new cases live in that file, not in a duplicate test suite.
`test-results.tap` records the run.

Run `node notes/codex-pr-gate/smoke.mjs` from the repository root.
An optional installed-gate file argument compares the unchanged affected version with the fixed source.
The runner supplies JSON on stdin to gate processes only; it never executes a PR command.
The saved `smoke-results.json` records:

- Fixed gate, genuine activation fixture: allow, exit zero and empty stdout.
- Fixed gate, same session without activation: deny.
- Installed affected gate, genuine activation fixture: deny.
- Installed affected gate, same session without activation: deny.

This proves the replay decision changed as intended, while explicitly retaining the raw-stdin capture limitation above.
No PR was created or attempted during this task.
