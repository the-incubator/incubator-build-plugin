// PreToolUse hook — blocks raw `gh pr create` unless the
// `inc-commit-push-pr` skill has been activated in this session.
//
// Enforces the PR workflow at the shell level: Claude must load the skill
// (which extracts intent and writes a proper description) before it can open
// a PR. The skill itself runs `gh pr create` once activated; this hook just
// denies the shortcut path.
//
// Fails open on any unexpected error — never bricks a session.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readStdinJson } from "./_util.mjs";

const SKILL_NAME = "inc-commit-push-pr";
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function skillActivated(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  let raw;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    // Fast substring check before parsing — transcripts can be large.
    if (!line.includes(SKILL_NAME)) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      if (block.name !== "Skill") continue;
      const skill = String(block.input?.skill ?? "");
      // Match both bare and plugin-scoped forms (e.g. "incubator:inc-commit-push-pr").
      if (skill === SKILL_NAME || skill.endsWith(`:${SKILL_NAME}`)) return true;
    }
  }
  return false;
}

async function main() {
  const payload = await readStdinJson(500);
  if (!payload) return 0;
  if (payload.tool_name !== "Bash") return 0;

  const command = String(payload.tool_input?.command ?? "");
  if (!GH_PR_CREATE_RE.test(command)) return 0;

  if (await skillActivated(payload.transcript_path)) return 0;

  deny(
    `Raw \`gh pr create\` is blocked. Load the \`inc-commit-push-pr\` skill first — it extracts the business intent behind the change and writes a value-first PR description, then runs the create command itself. Invoke it with the Skill tool (skill: "inc-commit-push-pr") and let it drive.`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch(() => process.exit(0));
