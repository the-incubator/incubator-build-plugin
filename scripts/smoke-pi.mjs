#!/usr/bin/env node
// Optional live smoke: installed Pi required; no model prompts, credentials, or user config.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, ".context"), { recursive: true });
const scratch = mkdtempSync(join(root, ".context/pi smoke "));
const cwd = join(scratch, "unrelated project");
mkdirSync(cwd);
const env = { ...process.env, HOME: join(scratch, "home"), PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
mkdirSync(env.HOME);
const expected = readdirSync(join(root, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
  const content = readFileSync(join(root, "skills", e.name, "SKILL.md"), "utf8");
  return `skill:${yaml.load(content.match(/^---\n([\s\S]*?)\n---/)[1]).name}`;
}).sort();

async function commands(args, agentDir) {
  const child = spawn("pi", ["--offline", "--mode", "rpc", "--no-session", "--no-context-files", "--no-approve", ...args], {
    cwd, env: { ...env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  try {
    return await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi discovery timed out: ${stderr}`)), 30_000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolveResult(value); };
      child.on("error", (error) => finish(error));
      child.on("exit", (code) => finish(new Error(`Pi exited before discovery (${code}): ${stderr}`)));
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        let newline;
        while ((newline = stdout.indexOf("\n")) !== -1) {
          const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (record.type === "extension_error") return finish(new Error(JSON.stringify(record)));
          if (record.id === "discovery") {
            if (!record.success) return finish(new Error(JSON.stringify(record)));
            return finish(null, record.data.commands.filter((c) => c.source === "skill").map((c) => c.name).sort());
          }
        }
      });
      child.stdin.write('{"id":"discovery","type":"get_commands"}\n');
    });
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise((done) => { child.once("exit", done); child.kill("SIGTERM"); });
    }
  }
}

try {
  const version = execFileSync("pi", ["--version"], { env, encoding: "utf8" }).trim();
  execFileSync("pi", ["install", root], { cwd, env, encoding: "utf8", timeout: 30_000 });
  assert.deepEqual(await commands([], env.PI_CODING_AGENT_DIR), expected);
  // Separate clean profile proves extension-only discovery, not just package.pi.skills.
  assert.deepEqual(await commands(["-e", join(root, ".pi/extensions/incubator-build.js")], join(scratch, "extension-only")), expected);
  console.log(JSON.stringify({ pi: version, skills: expected.length, installedPackageDiscovery: "passed", extensionOnlyDiscovery: "passed", modelCalls: 0 }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
