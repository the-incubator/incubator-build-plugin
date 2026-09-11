import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "incubator-onboard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const codexHome = join(dir, "custom-codex");
  mkdirSync(bin);
  mkdirSync(codexHome);
  const calls = join(dir, "calls");
  writeFileSync(join(bin, "codex"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\ncase "$*" in\n  "plugin marketplace add "*) exit "${ADD_STATUS:-0}" ;;\nesac\n', { mode: 0o755 });
  const env = { ...process.env, HOME: dir, CODEX_HOME: codexHome, PATH: `${bin}:${process.env.PATH}`, CALLS: calls };
  const run = (args = [], input = "y\n") => spawnSync("bash", [join(root, "scripts/toggle-local.sh"), "codex", ...args], { cwd: dir, env, input, encoding: "utf8" });
  const readCalls = () => {
    try { return readFileSync(calls, "utf8").trim().split("\n"); } catch { return []; }
  };
  return { codexHome, env, run, readCalls };
}

test("fresh Codex defaults to Git main and actually installs the plugin", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.readCalls(), [
    "plugin marketplace add the-incubator/incubator-build-plugin --ref main",
    "plugin add incubator-build@incubator",
  ]);
});

test("explicit prod upgrades a local source in custom CODEX_HOME without removing it first", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.codexHome, "config.toml"), `[marketplaces.incubator]\nsource_type = "local"\nsource = ${JSON.stringify("/old/local-marketplace-parent")}\n`);
  const result = f.run(["prod"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Current: LOCAL/);
  assert.deepEqual(f.readCalls(), [
    "plugin marketplace add the-incubator/incubator-build-plugin --ref main",
    "plugin add incubator-build@incubator",
  ]);
});

test("explicit local uses this plugin repository, not its parent directory", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["local"]).status, 0);
  assert.deepEqual(f.readCalls(), [`plugin marketplace add ${root}`, "plugin add incubator-build@incubator"]);
});

test("failed registration prevents install; declining performs no commands", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["prod"], "n\n").status, 0);
  assert.deepEqual(f.readCalls(), []);
  f.env.ADD_STATUS = "1";
  assert.equal(f.run(["prod"]).status, 1);
  assert.equal(f.readCalls().length, 1);
});
