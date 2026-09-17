# Multi-host distribution - testing checklist

## 1. Core Happy Path

- [ ] **Install in Claude and Codex app/CLI** - The read-only guide appears, loads, and explains the same workflow after restart.
- [ ] **Install in Cursor and Pi** - The guide loads from an unrelated project and resolves bundled sibling skills and persona files from the retained installation.
- [ ] **Run an authorized review-and-PR on a disposable branch** - Review, intent confirmation, watch, and feedback resolution complete in order and stop before merge.
- [ ] **Install in an additional target host** - The README installation route exposes skills or the documented explicit-file fallback without claiming hook support.

## 2. Secondary Happy Path

- [ ] **Reload or restart after an update** - New skill content appears without a second copied corpus or duplicate commands.
- [ ] **Repeat a Cursor/Cline installation** - Existing links remain valid and unrelated skills remain untouched.
- [ ] **Use OpenCode with existing custom commands** - Existing command definitions and skill paths are preserved.

## 3. Edge Cases & Failure Modes

- [ ] **Try review without subagent support** - The chain reports a capability gap and does not commit or create a PR.
- [ ] **Return no fresh review artifact or unresolved findings** - Review-and-PR stops rather than treating missing evidence as a clean review.
- [ ] **Reach a question without a native question tool** - The agent says it is waiting and does not continue without an answer.
- [ ] **Hit a Codex PR-gate denial after file-based composition** - The agent stops and reports the limitation without disabling hooks or fabricating activation evidence.
- [ ] **Install over a foreign or broken skill link** - The installer reports a conflict and preserves the existing entry.
