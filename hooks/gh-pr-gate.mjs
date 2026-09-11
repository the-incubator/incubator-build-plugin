// PreToolUse hook - blocks PR creation unless the PR workflow
// skill has been activated in this session when a transcript is available.
//
// Enforces the PR workflow at the tool layer: the host must load the skill
// (which extracts intent and writes a proper description) before it can open
// a PR. The skill itself opens the PR once activated; this hook denies every
// shortcut path that would skip it. Firstmate-managed sessions do not save a
// transcript, so those sessions are intentionally advisory: without a
// transcript the hook cannot prove whether the skill ran and allows the call.
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
import { prWorkflowSkill } from "./pr-workflow-skill.mjs";

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

async function activationEvidence(transcriptPath, sessionId, skill) {
  const absent = { activated: false, codex: false };
  let raw;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return absent;
  }
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      // Do not retain tool outputs or encrypted reasoning from large rollouts.
      if (record?.type === "session_meta" ||
          (record?.type === "event_msg" && record.payload?.type === "item_completed" &&
            record.payload.item?.type === "UserMessage") ||
          (record?.type === "response_item" && record.payload?.type === "message" && record.payload.role === "user") ||
          Array.isArray(record?.message?.content)) records.push(record);
    } catch {
      continue;
    }
  }

  // Codex rollouts may contain inherited history. The FIRST session_meta owns
  // the file; an item_completed event binds each activation turn to its thread.
  // Text, XML tags, or a file read alone are never activation evidence.
  const session = records.find((record) => record?.type === "session_meta")?.payload;
  if (session) {
    const denied = { activated: false, codex: true };
    if (typeof sessionId !== "string" || !sessionId || session.id !== sessionId) return denied;
    if (session.session_id !== undefined && session.session_id !== sessionId) return denied;
    const turns = new Set();
    for (const record of records) {
      const event = record?.payload;
      if (record?.type === "event_msg" && event?.type === "item_completed" &&
          event.thread_id === sessionId && typeof event.turn_id === "string" &&
          event.item?.type === "UserMessage") turns.add(event.turn_id);
      if (record?.type !== "response_item" || event?.type !== "message" || event.role !== "user") continue;
      const metadata = event.internal_chat_message_metadata_passthrough;
      if (!turns.has(metadata?.turn_id) || !Array.isArray(event.content) ||
          !Array.isArray(metadata?.content_item_kinds) ||
          metadata.content_item_kinds.length !== event.content.length) continue;
      for (const [index, block] of event.content.entries()) {
        if (metadata.content_item_kinds[index] !== "skills.selected_skill_instructions" ||
            block?.type !== "input_text" || typeof block.text !== "string") continue;
        const name = /^<skill>\r?\n<name>([^<>\r\n]+)<\/name>\r?\n<path>[^<>\r\n]+<\/path>\r?\n[\s\S]*\r?\n<\/skill>$/.exec(block.text)?.[1];
        if (skill.matches(name)) return { activated: true, codex: true };
      }
    }
    return denied;
  }

  for (const msg of records) {
    // Claude records are left intact. Reject an explicitly foreign session;
    // older transcripts without a per-record sessionId remain supported.
    if (sessionId && msg?.sessionId && msg.sessionId !== sessionId) continue;
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      if (block.name !== "Skill") continue;
      if (skill.matches(block.input?.skill)) return { activated: true, codex: false };
    }
  }
  return absent;
}

function transcriptAvailable(transcriptPath) {
  return Boolean(transcriptPath && existsSync(transcriptPath));
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

  // Transcript-off sessions cannot provide the proof this gate relies on.
  // Keep enforcement hard whenever the transcript exists; only the
  // provably-unavailable case is allowed to proceed without skill evidence.
  if (!transcriptAvailable(payload.transcript_path)) return 0;
  const skill = prWorkflowSkill();
  const evidence = await activationEvidence(payload.transcript_path, payload.session_id, skill);
  if (evidence.activated) return 0;
  const instruction = evidence.codex || typeof payload.turn_id === "string"
    ? `Activate \`$${skill.name}\` in Codex first`
    : `Load the \`${skill.name}\` skill first (Skill tool, skill: "${skill.name}")`;

  deny(
    `Opening a PR is blocked because the \`${skill.name}\` skill was not found in the available session transcript. ` +
      `This applies to every path - \`gh pr create\`, the REST API ` +
      `(\`gh api .../pulls\`, \`curl\`), GraphQL \`createPullRequest\` mutations, and MCP ` +
      `\`create_pull_request\` tools - not just the CLI shortcut. ${instruction}; ` +
      `it extracts the business intent, writes a value-first description, and opens the PR itself.`,
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
