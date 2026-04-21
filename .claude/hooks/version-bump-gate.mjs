// PreToolUse hook: block `git push` / `gh pr merge` from the plugin repo
// when plugin.json's version matches origin/main but plugin content
// (skills/, agents/, hooks/) has changed vs origin/main.
//
// Fails open on every error — never bricks a session.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PUSH_OR_MERGE_RE = /(?:^|[&|;]|\s)(?:git\s+push|gh\s+pr\s+merge)(?:\s|$)/;
const CONTENT_PREFIXES = ["skills/", "agents/", "hooks/"];

function readStdinJson(timeoutMs = 500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let buf = "";
    const done = (val) => {
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(val);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => {
      try {
        done(buf ? JSON.parse(buf) : null);
      } catch {
        done(null);
      }
    });
    process.stdin.on("error", () => done(null));
  });
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
  process.exit(0);
}

function git(args, cwd) {
  return execFileSync("git", args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function main() {
  const payload = await readStdinJson();
  if (!payload || payload.tool_name !== "Bash") return;
  const command = String(payload.tool_input?.command ?? "");
  if (!PUSH_OR_MERGE_RE.test(command)) return;

  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], process.cwd());
  } catch {
    return;
  }

  const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) return;

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return;
  }
  if (manifest.name !== "incubator-build") return;

  const localVersion = manifest.version;
  let mainVersion;
  try {
    const mainManifest = git(["show", "origin/main:.claude-plugin/plugin.json"], root);
    mainVersion = JSON.parse(mainManifest).version;
  } catch {
    return;
  }

  if (localVersion !== mainVersion) return;

  let changedFiles;
  try {
    changedFiles = git(["diff", "--name-only", "origin/main...HEAD"], root)
      .split("\n")
      .filter(Boolean);
  } catch {
    return;
  }

  const contentChanged = changedFiles.some((f) =>
    CONTENT_PREFIXES.some((p) => f.startsWith(p)),
  );
  if (!contentChanged) return;

  deny(
    `Blocked: plugin.json version (${localVersion}) matches origin/main, but this branch changes plugin content under skills/, agents/, or hooks/. Bump the version in .claude-plugin/plugin.json (semver) so clients pull the update, then re-run.`,
  );
}

main().catch(() => {});
