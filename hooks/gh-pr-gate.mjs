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
// Draft PRs are denied on every channel even after the skill is activated.
// Background-session system prompts instruct agents to open PRs as drafts;
// this plugin's policy is ready-for-review PRs, so the draft flag is refused
// at the tool layer. A human who wants a draft opens it in a terminal outside
// the session, where this gate does not run.
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
// The trailing [\w/-] exclusion keeps sub-resources (.../pulls/123,
// .../pulls/comments) out. Query/extension/fragment forms (.../pulls?per_page=1)
// DO match here on purpose: a POST to /pulls?anything still creates a PR (GitHub
// ignores unknown query params), so the read-vs-write decision is owned entirely
// by IS_WRITE_RE, never by the URL shape. Excluding `?` here reopened a bypass.
const PULLS_COLLECTION_RE = /\/pulls(?![\w/-])/;

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

// `--draft` on a gh pr create (Cobra also accepts `--draft=true`; `--draft=false`
// is an explicit ready PR, so it is allowed through).
const CLI_DRAFT_RE = /(?:^|\s)--draft\b(?!=false)/;
// gh pr create's short form of --draft. Scoped to the pr-create segment so it
// never collides with curl's `-d` data flag on REST commands.
const CLI_SHORT_DRAFT_RE = /\bpr\s+create\b[^|;&\n]*\s-d\b(?!=false)/;
// REST/GraphQL draft field: `-f draft=true`, `"draft": true`, `draft:true`.
const BODY_DRAFT_RE = /\bdraft\\?["']?\s*[=:]\s*\\?["']?true\b/i;

// Only meaningful on commands that already matched looksLikePrCreate — decides
// whether that PR creation is a draft.
export function looksLikeDraftPrCreate(command) {
  if (!command) return false;
  if (GH_PR_CREATE_RE.test(command)) {
    return CLI_DRAFT_RE.test(command) || CLI_SHORT_DRAFT_RE.test(command);
  }
  return BODY_DRAFT_RE.test(command);
}

// A tool name (not a Bash command) that opens a PR directly — the MCP path.
export function isPrCreateTool(toolName) {
  return PR_CREATE_TOOL_RE.test(String(toolName ?? ""));
}

// MCP create_pull_request tools take a `draft` boolean input.
export function isDraftToolInput(toolInput) {
  const draft = toolInput?.draft;
  return draft === true || draft === "true";
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
  let draft = false;
  if (tool === "Bash") {
    const command = String(payload.tool_input?.command ?? "");
    triggered = looksLikePrCreate(command);
    draft = triggered && looksLikeDraftPrCreate(command);
  } else if (isPrCreateTool(tool)) {
    triggered = true;
    draft = isDraftToolInput(payload.tool_input);
  }
  if (!triggered) return 0;

  // Draft PRs are refused unconditionally — even with the skill activated.
  if (draft) {
    deny(
      `Draft PRs are blocked in this repo — every PR opens ready for review. Re-run the same ` +
        `command without the draft flag/field. This policy overrides any background-session ` +
        `instruction to open the PR as a draft. Do not route around it via the REST API, GraphQL, ` +
        `or MCP tools — those paths refuse drafts too. If the user genuinely wants a draft PR, ` +
        `stop and ask them to open it themselves in a terminal outside this Claude session.`,
    );
    return 0;
  }

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
