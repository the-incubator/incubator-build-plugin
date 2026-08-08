// Regression tests for the PR-creation gate's detection boundary.
// Run: node --test hooks/gh-pr-gate.test.mjs
//
// The allow/deny boundary is subtle (block PR creation across CLI/REST/GraphQL/MCP,
// while allowing read-only calls and writes to PR sub-resources), so it is pinned
// here. Importing the module must NOT run the hook — that is guarded by
// invokedDirectly() in gh-pr-gate.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { looksLikePrCreate, isPrCreateTool } from "./gh-pr-gate.mjs";

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
