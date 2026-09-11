import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { detectHost, runUpdate, updatePaths } from "./plugin-update.mjs";

function fixture(t, source = "git") {
  const home = mkdtempSync(join(tmpdir(), "incubator-update-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: join(home, "custom codex") };
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: args.includes("list") ? JSON.stringify({ marketplaces: [{ name: "incubator", marketplaceSource: { sourceType: source } }] }) : "ok", stderr: "" };
  };
  return { home, env, run, calls, host: "codex", now: Date.now() };
}

test("detects Codex cache and actual root binding; inherited CODEX_HOME alone does not misroute Claude", () => {
  const home = "/users/operator";
  assert.equal(detectHost({}, `${home}/.codex/plugins/cache/incubator/incubator-build/1.0.0`, home), "codex");
  assert.equal(detectHost({ CODEX_HOME: "/custom", PLUGIN_ROOT: "/plugin" }, "/plugin", home), "codex");
  assert.equal(detectHost({ CODEX_HOME: "/custom", PLUGIN_ROOT: "/old-codex-plugin" }, "/claude-plugin", home), "claude");
  assert.equal(detectHost({ CODEX_HOME: "/custom", CODEX_THREAD_ID: "inherited" }, "/claude-plugin", home), "claude");
  assert.equal(detectHost({ CLAUDE_PLUGIN_ROOT: "/claude-plugin" }, "/claude-plugin", home), "claude");
});

test("Codex refreshes Git marketplace then reinstalls, preserving custom CODEX_HOME", (t) => {
  const f = fixture(t);
  assert.equal(runUpdate(f).status, "updated");
  assert.deepEqual(f.calls, [
    ["codex", "plugin", "marketplace", "list", "--json"],
    ["codex", "plugin", "marketplace", "upgrade", "incubator"],
    ["codex", "plugin", "add", "incubator-build@incubator"],
  ]);
  assert.match(readFileSync(updatePaths(f.host, f.env, f.home).log, "utf8"), /Start a new session/);
});

test("Claude retains refresh/update flow and its throttle cannot suppress Codex", (t) => {
  const f = fixture(t);
  assert.equal(runUpdate({ ...f, host: "claude" }).status, "updated");
  assert.deepEqual(f.calls, [
    ["claude", "plugin", "marketplace", "update", "incubator"],
    ["claude", "plugin", "update", "incubator-build@incubator"],
  ]);
  assert.equal(runUpdate(f).status, "updated");
});

test("throttles both lifecycle events; explicit force bypasses the hour", (t) => {
  const f = fixture(t);
  runUpdate(f);
  assert.equal(runUpdate({ ...f, now: f.now + 1 }).status, "throttled");
  assert.equal(f.calls.length, 3);
  assert.equal(runUpdate({ ...f, force: true, now: f.now + 2 }).status, "updated");
  assert.equal(f.calls.length, 6);
});

for (const source of ["local", "unknown"]) {
  test(`does not silently replace a ${source} marketplace`, (t) => {
    const f = fixture(t, source);
    assert.equal(runUpdate(f).status, "not-git");
    assert.equal(f.calls.length, 1);
    assert.match(readFileSync(updatePaths(f.host, f.env, f.home).log, "utf8"), /marketplace add the-incubator\/incubator-build-plugin --ref main/);
  });
}

for (const failure of ["refresh", "install", "missing-cli", "invalid-json", "timeout"]) {
  test(`${failure} is logged and never reported as a successful update`, (t) => {
    const f = fixture(t);
    const success = f.run;
    f.run = (command, args, env) => {
      if (failure === "missing-cli") return { status: null, error: new Error("ENOENT") };
      if (failure === "invalid-json") return { status: 0, stdout: "invalid" };
      const result = success(command, args, env);
      if ((failure === "refresh" && args.includes("upgrade")) || (failure === "install" && args.includes("add"))) return { status: 1, stderr: "authorization failed" };
      if (failure === "timeout" && args.includes("upgrade")) return { status: null, error: new Error("ETIMEDOUT") };
      return result;
    };
    assert.equal(runUpdate(f).status, "failed");
    if (failure === "refresh" || failure === "timeout") assert.equal(f.calls.length, 2, "must not install a stale snapshot after a failed refresh");
    assert.match(readFileSync(updatePaths(f.host, f.env, f.home).log, "utf8"), /Update failed:/);
    assert.equal(runUpdate({ ...f, now: f.now + 1 }).status, "throttled", "failed attempts must not create retry storms");
    assert.equal(runUpdate({ ...f, run: success, force: true }).status, "updated", "failure must release the lock");
  });
}

test("concurrent starts serialize even with force", (t) => {
  const f = fixture(t);
  const success = f.run;
  f.run = (...args) => {
    assert.equal(runUpdate({ ...f, force: true, run: success }).status, "busy");
    return success(...args);
  };
  assert.equal(runUpdate(f).status, "updated");
  assert.equal(f.calls.length, 3);
});

test("recovers an abandoned lock and a future timestamp", (t) => {
  const f = fixture(t);
  const paths = updatePaths(f.host, f.env, f.home);
  mkdirSync(paths.lock, { recursive: true });
  const old = new Date(f.now - 20 * 60 * 1000);
  utimesSync(paths.lock, old, old);
  writeFileSync(paths.stamp, String(f.now + 10_000));
  assert.equal(runUpdate(f).status, "updated");
});

test("hook launches a detached Codex worker with inherited home and throttles repeated starts", async (t) => {
  const f = fixture(t);
  const bin = join(f.home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), JSON.stringify({ type: "commonjs" }));
  const callsPath = join(f.home, "native-calls.jsonl");
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const {appendFileSync}=require("node:fs");
const args=process.argv.slice(2);
appendFileSync(process.env.TEST_CALLS,JSON.stringify(args)+"\\n");
if(args.includes("list")) console.log(JSON.stringify({marketplaces:[{name:"incubator",marketplaceSource:{sourceType:"git"}}]}));
`, { mode: 0o755 });
  const pluginRoot = join(import.meta.dirname, "..");
  const env = { ...process.env, ...f.env, HOME: f.home, PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_ROOT: pluginRoot, PATH: `${bin}:${process.env.PATH}`, TEST_CALLS: callsPath };
  delete env.INCUBATOR_PLUGIN_UPDATE_DISABLED;
  const script = join(import.meta.dirname, "plugin-update.mjs");
  const alias = join(f.home, "updater-link.mjs");
  symlinkSync(script, alias);
  assert.equal(spawnSync(process.execPath, [alias], { env, encoding: "utf8" }).status, 0);
  const paths = updatePaths("codex", env, f.home);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(paths.log) && readFileSync(paths.log, "utf8").includes("Updated.") && !existsSync(paths.lock)) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.match(readFileSync(paths.log, "utf8"), /Updated\./);
  const firstCalls = readFileSync(callsPath, "utf8");
  assert.equal(firstCalls.trim().split("\n").length, 3);
  // A foreground worker gives an observable completion for the second event.
  assert.equal(spawnSync(process.execPath, [script, "--run"], { env, encoding: "utf8" }).status, 0);
  assert.equal(readFileSync(callsPath, "utf8"), firstCalls);
});
