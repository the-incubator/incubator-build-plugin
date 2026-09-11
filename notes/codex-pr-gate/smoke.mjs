// Non-publishing replay. Only executes the gate process, never the input command.
// Run from the repository root:
//   node notes/codex-pr-gate/smoke.mjs [installed-gate-path] [--write[=PATH]]
// By default it prints results to stdout and writes nothing, so a plain run never
// dirties the worktree. The committed canonical smoke-results.json (with the
// installed-gate rows) stays authoritative; regenerate it deliberately with an
// installed gate and --write, or send ordinary runs to a temp path via --write=PATH.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

const args = process.argv.slice(2);
const installedGate = args.find((a) => !a.startsWith("--"));
const writeArg = args.find((a) => a === "--write" || a.startsWith("--write="));

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
if (installedGate) {
  results.installedActivation = decision(installedGate, positive);
  results.installedNoActivation = decision(installedGate, negative);
  assert.equal(results.installedActivation, "deny");
  assert.equal(results.installedNoActivation, "deny");
}

const output = JSON.stringify(results, null, 2) + "\n";
process.stdout.write(output);

if (writeArg) {
  const explicit = writeArg.includes("=") ? writeArg.slice(writeArg.indexOf("=") + 1) : null;
  const canonical = new URL("./smoke-results.json", import.meta.url);
  const target = explicit ? resolve(explicit) : canonical;
  // Refuse to overwrite the canonical four-row artifact with a partial fixed-only run.
  if (!explicit && !installedGate) {
    throw new Error("refusing to overwrite canonical smoke-results.json without an installed gate; pass the installed-gate path, or --write=PATH for a scratch file");
  }
  writeFileSync(target, output);
}
