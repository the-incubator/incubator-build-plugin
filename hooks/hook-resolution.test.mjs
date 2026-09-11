import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(process.env.INCUBATOR_TEST_HOOKS_MANIFEST || join(root, "hooks/hooks.json"), "utf8"));
const commands = Object.values(manifest.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "incubator hook resolution "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pluginRoot = join(dir, "plugin with spaces");
  symlinkSync(root, pluginRoot, "dir");
  const cwd = join(dir, "unrelated project");
  mkdirSync(cwd);
  const env = { ...process.env, HOME: dir, CODEX_HOME: join(dir, ".codex"), INCUBATOR_TELEMETRY_DISABLED: "1", INCUBATOR_PLUGIN_UPDATE_DISABLED: "1" };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.PLUGIN_ROOT;
  return { dir, pluginRoot, cwd, env };
}

for (const binding of ["CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT", "both", "empty-claude"]) {
  test(`every declared hook resolves with ${binding}, including paths containing spaces`, (t) => {
    const { pluginRoot, cwd, env } = fixture(t);
    if (binding === "both") {
      env.CLAUDE_PLUGIN_ROOT = pluginRoot;
      env.PLUGIN_ROOT = "/nonexistent/fallback-must-not-win";
    } else if (binding === "empty-claude") {
      env.CLAUDE_PLUGIN_ROOT = "";
      env.PLUGIN_ROOT = pluginRoot;
    } else env[binding] = pluginRoot;
    for (const command of commands) {
      const result = spawnSync("sh", ["-c", command], { cwd, env, input: "{}", encoding: "utf8" });
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
      assert.doesNotMatch(result.stderr, /Cannot find module/);
    }
  });
}

test("every hook fails clearly without a root, even when cwd contains the real plugin", (t) => {
  const { env } = fixture(t);
  for (const command of commands) {
    const result = spawnSync("sh", ["-c", command], { cwd: root, env, input: "{}", encoding: "utf8" });
    assert.notEqual(result.status, 0, `must not silently execute from cwd: ${command}`);
    assert.match(result.stderr, /Incubator Build hooks require CLAUDE_PLUGIN_ROOT or PLUGIN_ROOT/);
    assert.doesNotMatch(result.stderr, /Cannot find module/);
  }
});

test("resolved PR gate still denies missing activation through the hooks.json command", (t) => {
  const { dir, pluginRoot, cwd, env } = fixture(t);
  env.PLUGIN_ROOT = pluginRoot;
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "{}\n");
  const command = commands.find((value) => value.includes("/gh-pr-gate.mjs"));
  const result = spawnSync("sh", ["-c", command], {
    cwd, env, encoding: "utf8",
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr create --title example" }, transcript_path: transcript }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});
