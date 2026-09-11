// Regression tests for the PR-creation gate's detection boundary.
// Run: node --test hooks/gh-pr-gate.test.mjs
//
// The allow/deny boundary is subtle (block PR creation across CLI/REST/GraphQL/MCP,
// while allowing read-only calls and writes to PR sub-resources), so it is pinned
// here. Importing the module must NOT run the hook — that is guarded by
// invokedDirectly() in gh-pr-gate.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { looksLikePrCreate, isPrCreateTool, loadPrWorkflowSkill } from "./gh-pr-gate.mjs";
import { prWorkflowSkill, parseSkillName } from "./pr-workflow-skill.mjs";

const BLOCK = [
  ["cli basic", "gh pr create --title x --body y"],
  ["cli spaced", "gh   pr    create -f"],
  ["cli abs path", "/opt/homebrew/bin/gh pr create"],
  ["rest fields", "gh api repos/o/r/pulls -f title=x -f head=b -f base=main"],
  ["rest -X POST", "gh api -X POST repos/o/r/pulls --input body.json"],
  ["rest --method POST", "gh api --method POST repos/o/r/pulls -f title=x"],
  ["curl -X POST", "curl -X POST https://api.github.com/repos/o/r/pulls -d @body.json"],
  ["curl data only", "curl https://api.github.com/repos/o/r/pulls --data {x}"],
  ["graphql mutation inline", "gh api graphql -f query=mutation{createPullRequest(input:{})}"],
  ["wget post-data", "wget --post-data={} https://api.github.com/repos/o/r/pulls"],
  // A query string on the create URL must NOT evade the gate: `gh api ... -f` is
  // a POST, and GitHub ignores unknown query params, so this still creates a PR.
  ["rest create with query string (bypass closed)", "gh api repos/o/r/pulls?per_page=1 -f title=x -f head=b -f base=main"],
];

const ALLOW = [
  ["pr list", "gh pr list"],
  ["pr view", "gh pr view 125"],
  ["pr view comments", "gh pr view 125 --comments"],
  ["rest list GET", "gh api repos/o/r/pulls"],
  ["rest list query GET (no write flags)", 'gh api "repos/o/r/pulls?state=open"'],
  ["pulls extension read", "gh api repos/o/r/pulls.json"],
  ["specific pr read", "gh api repos/o/r/pulls/125"],
  ["specific pr write (update, not create)", "gh api -X POST repos/o/r/pulls/125/comments -f body=hi"],
  ["pr review (sub-resource write)", "gh api repos/o/r/pulls/125/reviews -f event=APPROVE"],
  ["issues create (not pulls)", "gh api repos/o/r/issues -f title=bug"],
  ["unrelated", "git push origin HEAD"],
  ["empty (fail-open)", ""],
];

test("blocks PR-creation across all channels", () => {
  for (const [name, cmd] of BLOCK) {
    assert.equal(looksLikePrCreate(cmd), true, `should BLOCK: ${name} :: ${cmd}`);
  }
});

test("allows read-only calls and sub-resource writes", () => {
  for (const [name, cmd] of ALLOW) {
    assert.equal(looksLikePrCreate(cmd), false, `should ALLOW: ${name} :: ${cmd}`);
  }
});

test("matches MCP create_pull_request tool names by suffix", () => {
  assert.equal(isPrCreateTool("mcp__github__create_pull_request"), true);
  assert.equal(isPrCreateTool("create_pull_request"), true);
  assert.equal(isPrCreateTool("Bash"), false);
  assert.equal(isPrCreateTool("mcp__github__list_pull_requests"), false);
  assert.equal(isPrCreateTool(undefined), false);
});

function runGate(payload) {
  const result = spawnSync(process.execPath, ["hooks/gh-pr-gate.mjs"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function prPayload(transcript_path) {
  return {
    tool_name: "Bash",
    tool_input: { command: "gh pr create --title x" },
    ...(transcript_path === undefined ? {} : { transcript_path }),
  };
}

test("transcript-unavailable sessions are advisory, while available transcripts stay enforced", () => {
  const missingPath = join(tmpdir(), `gh-pr-gate-missing-${Date.now()}`);
  const transcriptDir = mkdtempSync(join(tmpdir(), "gh-pr-gate-"));
  const transcriptPath = join(transcriptDir, "session.jsonl");

  try {
    assert.equal(runGate(prPayload()), null, "absent transcript_path should allow");
    assert.equal(runGate(prPayload(missingPath)), null, "missing transcript file should allow");

    writeFileSync(transcriptPath, "{}\n");
    assert.equal(
      runGate(prPayload(transcriptPath))?.hookSpecificOutput?.permissionDecision,
      "deny",
      "available transcript without skill evidence should deny",
    );

    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        message: {
          content: [
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "inc-commit-push-pr" },
            },
          ],
        },
      })}\n`,
    );
    assert.equal(runGate(prPayload(transcriptPath)), null, "skill evidence should allow");
  } finally {
    rmSync(transcriptDir, { recursive: true, force: true });
  }
});

const capturedCodex = readFileSync(new URL("../notes/codex-pr-gate/codex-activation.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
const codexInput = JSON.parse(readFileSync(new URL("../notes/codex-pr-gate/reconstructed-hook-input.json", import.meta.url), "utf8"));

function withTranscript(records, check, input = codexInput) {
  const directory = mkdtempSync(join(tmpdir(), "gh-pr-gate-"));
  const path = join(directory, "session.jsonl");
  try {
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    check(runGate({ ...input, transcript_path: path }), path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectDenied(records, input = codexInput) {
  withTranscript(records, (result) => {
    assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny");
  }, input);
}

test("regression: captured genuine Codex activation preceding the reproduced denial allows", () => {
  withTranscript(capturedCodex, (result) => assert.equal(result, null));
});

test("captured Claude activation still allows and current Codex unrelated activation denies", () => {
  const claude = JSON.parse(readFileSync(new URL("../notes/codex-pr-gate/claude-activation.jsonl", import.meta.url), "utf8"));
  withTranscript([claude], (result) => assert.equal(result, null), { ...prPayload(), session_id: "claude-session-a" });
  const unrelated = JSON.parse(readFileSync(new URL("../notes/codex-pr-gate/codex-0.153.4-unrelated-skill.jsonl", import.meta.url), "utf8"));
  unrelated.payload.internal_chat_message_metadata_passthrough.turn_id = "codex-turn-a";
  expectDenied([...capturedCodex.slice(0, -1), unrelated]);
});

test("frontmatter identity resolves current and intentional legacy names in both hosts", () => {
  const identity = prWorkflowSkill();
  const names = [identity.name, `incubator-build:${identity.name}`, "inc-commit-push-pr", "incubator-build:inc-commit-push-pr"];
  assert.equal(identity.name, "inc:commit-push-pr-4");
  for (const name of names) {
    assert.equal(identity.matches(name), true);
    const records = structuredClone(capturedCodex);
    records.at(-1).payload.content[0].text = records.at(-1).payload.content[0].text
      .replace(/<name>.*<\/name>/, `<name>${name}</name>`);
    withTranscript(records, (result) => assert.equal(result, null));
    withTranscript([{ message: { content: [{ type: "tool_use", name: "Skill", input: { skill: name } }] } }],
      (result) => assert.equal(result, null), prPayload());
  }
  for (const name of ["inc:review-3a", "inc-commit-push-pr-extra", "prefixinc-commit-push-pr", undefined]) {
    assert.equal(identity.matches(name), false);
  }
});

test("identity load fails CLOSED on an exotic or unreadable name, and binds a canonical one", () => {
  // The gate reads only the canonical simple scalar form. Any other YAML-legal
  // spelling must NOT parse here — validate-skills.mjs rejects it at CI, and if one
  // ever reached the runtime the gate must fail closed rather than fail open.
  assert.equal(parseSkillName("name: inc:commit-push-pr-4"), "inc:commit-push-pr-4");
  for (const exotic of [
    'name: "inc:commit-push-pr-4"',
    "name: 'inc:commit-push-pr-4'",
    "name: inc:commit-push-pr-4 # workflow",
    "name: >\n  inc:commit-push-pr-4",
    "description: no name here",
  ]) {
    assert.equal(parseSkillName(exotic), undefined, `exotic form must not parse: ${JSON.stringify(exotic)}`);
    const source = `---\n${exotic}\ndescription: x\n---\nbody\n`;
    // prWorkflowSkill throws on an unreadable name, and loadPrWorkflowSkill turns any
    // throw into the fail-CLOSED null the gate denies on — never a silent pass.
    assert.throws(() => prWorkflowSkill(source));
    assert.equal(loadPrWorkflowSkill(() => prWorkflowSkill(source)), null);
  }
  // An unreadable identity file (loader throws) also fails closed.
  assert.equal(loadPrWorkflowSkill(() => { throw new Error("ENOENT"); }), null);
  // A canonical name resolves, binds current + legacy spellings, and loads for real.
  const canonical = prWorkflowSkill("---\nname: inc:commit-push-pr-4\ndescription: x\n---\n");
  assert.equal(canonical.name, "inc:commit-push-pr-4");
  assert.equal(canonical.matches("incubator-build:inc:commit-push-pr-4"), true);
  assert.equal(canonical.matches("inc-commit-push-pr"), true);
  assert.ok(loadPrWorkflowSkill());
  assert.equal(loadPrWorkflowSkill().name, "inc:commit-push-pr-4");
  // With a valid identity and an available transcript, a session that never activated
  // the skill is still denied — enforcement is not weakened by the fail-closed change.
  withTranscript(capturedCodex.slice(0, -1), (result) => {
    assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny");
  });
});

test("available Codex transcript without activation denies with a Codex instruction", () => {
  withTranscript(capturedCodex.slice(0, -1), (result) => {
    assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /\$inc:commit-push-pr-4/);
    assert.doesNotMatch(result.hookSpecificOutput.permissionDecisionReason, /Skill tool/);
  });
  withTranscript([], (result) => assert.doesNotMatch(result.hookSpecificOutput.permissionDecisionReason, /Skill tool/));
});

test("Codex evidence from another session or inherited turn cannot authorize", () => {
  expectDenied(capturedCodex, { ...codexInput, session_id: "another-session" });
  expectDenied(capturedCodex, { ...codexInput, session_id: undefined });
  for (const mutate of [
    (records) => { records[0].payload.session_id = "foreign-session"; },
    (records) => { records[2].payload.thread_id = "parent-session"; },
    (records) => { records.at(-1).payload.internal_chat_message_metadata_passthrough.turn_id = "foreign-turn"; },
    (records) => { records.splice(2, 1); },
    (records) => { records.unshift({ type: "session_meta", payload: { id: "foreign-session" } }); },
  ]) {
    const records = structuredClone(capturedCodex);
    mutate(records);
    expectDenied(records);
  }
  // A fork owns its new file header but retains the parent's event thread IDs.
  const fork = structuredClone(capturedCodex);
  fork[0].payload.id = fork[0].payload.session_id = "child-session";
  expectDenied(fork, { ...codexInput, session_id: "child-session" });
});

test("mentions, exact XML pastes, file reads, unrelated skills and wrong metadata never activate", () => {
  for (const mutate of [
    (record) => { record.payload.content[0].text = "Please use inc:commit-push-pr-4"; },
    (record) => { record.payload.internal_chat_message_metadata_passthrough.content_item_kinds = ["user.text"]; },
    (record) => { delete record.payload.internal_chat_message_metadata_passthrough; },
    (record) => { record.payload.role = "assistant"; },
    (record) => { record.payload.content[0].text = record.payload.content[0].text.replace(/<name>.*<\/name>/, "<name>inc:review-3a</name>"); },
    (record) => { record.payload.content.unshift({ type: "input_text", text: "unrelated" }); },
    (record) => { record.payload.content[0].text = "example:\n" + record.payload.content[0].text; },
    (record) => { record.payload = { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "cat skills/inc-commit-push-pr/SKILL.md" }) }; },
  ]) {
    const records = structuredClone(capturedCodex);
    mutate(records.at(-1));
    expectDenied(records);
  }
  // Host metadata is per content block, not permission for adjacent pasted text.
  const records = structuredClone(capturedCodex);
  records.at(-1).payload.content.unshift({ type: "input_text", text: "<skill>\n<name>unrelated</name>\n<path>/skills/unrelated</path>\nbody\n</skill>" });
  records.at(-1).payload.internal_chat_message_metadata_passthrough.content_item_kinds.push("user.text");
  expectDenied(records);
});

test("CLI REST GraphQL and MCP decisions retain activation and read-only boundaries", () => {
  withTranscript(capturedCodex, (_, path) => {
    for (const [, command] of BLOCK) assert.equal(runGate({ ...codexInput, transcript_path: path, tool_input: { command } }), null);
    assert.equal(runGate({ ...codexInput, transcript_path: path, tool_name: "mcp__github__create_pull_request" }), null);
  });
  withTranscript(capturedCodex.slice(0, -1), (_, path) => {
    for (const [, command] of BLOCK) {
      assert.equal(runGate({ ...codexInput, transcript_path: path, tool_input: { command } })?.hookSpecificOutput?.permissionDecision, "deny");
    }
    assert.equal(runGate({ ...codexInput, transcript_path: path, tool_name: "mcp__github__create_pull_request" })?.hookSpecificOutput?.permissionDecision, "deny");
    for (const [, command] of ALLOW) assert.equal(runGate({ ...codexInput, transcript_path: path, tool_input: { command } }), null);
  });
});

test("Claude text, pasted tool examples and explicitly foreign records deny", () => {
  for (const record of [
    { message: { content: [{ type: "text", text: 'Skill {"skill":"inc-commit-push-pr"}' }] } },
    { sessionId: "foreign", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "inc-commit-push-pr" } }] } },
    { message: { content: [{ type: "tool_use", name: "Read", input: { skill: "inc-commit-push-pr" } }] } },
  ]) expectDenied([record], { ...prPayload(), session_id: "claude-session" });
  withTranscript([], (result) => assert.match(result.hookSpecificOutput.permissionDecisionReason, /Skill tool, skill: "inc:commit-push-pr-4"/), prPayload());
});

test("existing unreadable transcripts deny; malformed stdin and unexpected errors still fail open", () => {
  const directory = mkdtempSync(join(tmpdir(), "gh-pr-gate-unreadable-"));
  try {
    assert.equal(runGate(prPayload(directory))?.hookSpecificOutput?.permissionDecision, "deny");
    // Invalid paths remain unavailable; unexpected coercion errors reach main's catch.
    assert.equal(runGate(prPayload({ invalid: true })), null);
    assert.equal(runGate({ tool_name: { toString: null } }), null);
    const result = spawnSync(process.execPath, ["hooks/gh-pr-gate.mjs"], { input: "{invalid", encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
