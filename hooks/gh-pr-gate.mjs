// PreToolUse hook — blocks PR creation unless the `inc-commit-push-pr`
// skill has been activated in this session.
//
// Enforces the PR workflow at the tool layer: Claude must load the skill
// (which extracts intent and writes a proper description) before it can open
// a PR. The skill itself opens the PR once activated; this hook denies every
// shortcut path that would skip it.
//
// Channels gated (all of these were, or could be, used to route around the
// `gh pr create` block):
//   - `gh pr create`                          (the CLI shortcut)
//   - `gh api .../pulls` with a write          (REST create — the actual bypass used)
//   - `curl`/`wget`/`http` POST to `.../pulls` (REST create via raw HTTP)
//   - any `createPullRequest` GraphQL mutation (GraphQL create, gh api or curl)
//   - MCP `create_pull_request` tools          (direct tool, never touches the shell)
//
// Read-only calls (`gh pr list`, `gh pr view`, `gh api repos/O/R/pulls` with no
// write flags) are deliberately left alone.
//
// Fails open on any unexpected error — never bricks a session.

import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readStdinJson } from "./_util.mjs";

const SKILL_NAME = "inc-commit-push-pr";

// MCP tools that open a PR directly, bypassing the shell entirely. Matched as a
// suffix so any server namespace counts (e.g. "mcp__github__create_pull_request").
const PR_CREATE_TOOL_RE = /(?:^|__)create_pull_request$/;

// `gh pr create` — flexible whitespace, tolerant of an absolute path to gh.
const GH_PR_CREATE_RE = /\bgh\b[^|;&\n]*?\bpr\s+create\b/;

// A GraphQL mutation that opens a PR — works regardless of transport (gh api
// graphql, curl, http, etc.).
const GRAPHQL_CREATE_RE = /createPullRequest\b/;

// References the pulls *collection* endpoint (.../pulls) — the create target.
// Excludes sub-resources (.../pulls/123, .../pulls/comments) via the trailing
// [\w/-], and read forms that carry a query string, extension, or fragment
// (.../pulls?state=open, .../pulls.json, .../pulls#x) via ? . # — those are GETs.
const PULLS_COLLECTION_RE = /\/pulls(?![\w/?.#-])/;

// Signals that an HTTP request is a write rather than a read. Assembled from
// per-channel sub-patterns; `IS_WRITE_RE` owns the `i` flag for the whole set.
const HTTP_WRITE_SOURCE =
  // explicit method
  /(?:^|\s)(?:-X|--request|--method)[=\s]+POST\b/i.source +
  "|" +
  // gh api field flags imply POST
  /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\b/.source +
  "|" +
  // curl/wget data flags default to POST
  /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--post-data|--body)\b/.source;
const IS_WRITE_RE = new RegExp(HTTP_WRITE_SOURCE, "i");

export function looksLikePrCreate(command) {
  if (!command) return false;
  if (GH_PR_CREATE_RE.test(command)) return true;
  if (GRAPHQL_CREATE_RE.test(command)) return true;
  // REST create: must hit the pulls collection AND look like a write.
  if (PULLS_COLLECTION_RE.test(command) && IS_WRITE_RE.test(command)) return true;
  return false;
}

// A tool name (not a Bash command) that opens a PR directly — the MCP path.
export function isPrCreateTool(toolName) {
  return PR_CREATE_TOOL_RE.test(String(toolName ?? ""));
}

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

  const tool = String(payload.tool_name ?? "");

  let triggered = false;
  if (tool === "Bash") {
    triggered = looksLikePrCreate(String(payload.tool_input?.command ?? ""));
  } else if (isPrCreateTool(tool)) {
    triggered = true;
  }
  if (!triggered) return 0;

  if (await skillActivated(payload.transcript_path)) return 0;

  deny(
    `Opening a PR is blocked. This applies to every path — \`gh pr create\`, the REST API ` +
      `(\`gh api .../pulls\`, \`curl\`), GraphQL \`createPullRequest\` mutations, and MCP ` +
      `\`create_pull_request\` tools — not just the CLI shortcut. Do not route around this. ` +
      `Load the \`inc-commit-push-pr\` skill first (Skill tool, skill: "inc-commit-push-pr"); ` +
      `it extracts the business intent, writes a value-first description, and opens the PR itself. ` +
      `There is no in-session bypass — if a PR must skip the skill (e.g. an urgent hotfix), stop and ask ` +
      `the user to open it themselves in a terminal outside this Claude session, where this gate does not run.`,
  );
  return 0;
}

// Run the gate only when executed directly (`node gh-pr-gate.mjs`), not when a
// test imports the detection helpers. Fail safe: if the check throws, default to
// running — a guardrail must never silently disable itself.
function invokedDirectly() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return true;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch(() => process.exit(0));
}
