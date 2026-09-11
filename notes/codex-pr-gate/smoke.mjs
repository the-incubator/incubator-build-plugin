// Non-publishing replay. Only executes the gate process, never the input command.
// Run from the repository root: node notes/codex-pr-gate/smoke.mjs [installed-gate-path]
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const payload = JSON.parse(readFileSync(new URL("./reconstructed-hook-input.json", import.meta.url), "utf8"));
function decision(gate, transcript) {
  const result = spawnSync(process.execPath, [gate], {
    input: JSON.stringify({ ...payload, transcript_path: transcript }), encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : "allow";
}
const positive = "notes/codex-pr-gate/codex-activation.jsonl";
const negative = "notes/codex-pr-gate/codex-no-activation.jsonl";
const results = {
  inputProvenance: "Reconstructed hook stdin; sanitized genuine transcript records",
  publishing: false,
  fixedActivation: decision("hooks/gh-pr-gate.mjs", positive),
  fixedNoActivation: decision("hooks/gh-pr-gate.mjs", negative),
};
assert.equal(results.fixedActivation, "allow");
assert.equal(results.fixedNoActivation, "deny");
if (process.argv[2]) {
  results.installedActivation = decision(process.argv[2], positive);
  results.installedNoActivation = decision(process.argv[2], negative);
  assert.equal(results.installedActivation, "deny");
  assert.equal(results.installedNoActivation, "deny");
}
const output = JSON.stringify(results, null, 2) + "\n";
writeFileSync(new URL("./smoke-results.json", import.meta.url), output);
process.stdout.write(output);
