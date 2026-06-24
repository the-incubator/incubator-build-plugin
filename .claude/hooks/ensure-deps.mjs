// SessionStart hook: install npm deps when a checkout is missing node_modules.
//
// Git has no native post-worktree-add event, so this fires on every session
// start and no-ops instantly once deps are present. The case it exists for:
// a fresh `git worktree add` (or fresh clone) has no node_modules - untracked
// files don't carry into a new worktree - so `npm run test:skills` / test:hooks
// would fail until someone remembers to install. This removes that step.
//
// Fails open on every error - never bricks a session.

import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

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

function addContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: text,
      },
    }),
  );
}

async function main() {
  const payload = await readStdinJson();
  // The SessionStart payload carries the session cwd; CLAUDE_PROJECT_DIR is the
  // harness fallback (and is required to even launch this script). Don't fall
  // back to process.cwd() - inside a hook the cwd is the runner's, not the
  // project root, so it could silently target the wrong package in a monorepo.
  const root = payload?.cwd || process.env.CLAUDE_PROJECT_DIR;
  if (!root) return;

  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) return; // nothing to install for

  // npm writes node_modules/.package-lock.json after a successful install.
  // Treat deps as current only when that sentinel exists AND is at least as
  // new as the lockfile (or manifest) - otherwise a `git pull` that adds a
  // dependency leaves node_modules stale and this hook would never refresh it.
  const lockFile = path.join(root, "package-lock.json");
  const hasLock = existsSync(lockFile);
  const manifest = hasLock ? lockFile : pkgPath;
  const sentinel = path.join(root, "node_modules", ".package-lock.json");
  const fresh = (a, b) => {
    try {
      return statSync(a).mtimeMs >= statSync(b).mtimeMs;
    } catch {
      return false;
    }
  };
  if (existsSync(sentinel) && fresh(sentinel, manifest)) return; // current - no-op

  const args = hasLock
    ? ["ci", "--no-audit", "--no-fund"]
    : ["install", "--no-audit", "--no-fund"];

  const run = (a) =>
    execFileSync("npm", a, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });

  let installedVia = hasLock ? "npm ci" : "npm install";
  let drifted = false;
  try {
    run(args);
  } catch {
    // Without a lockfile the first command was already `npm install`; retrying
    // the identical command would just burn another timeout, so stop here.
    if (!hasLock) return;
    // `npm ci` is strict (fails on lockfile drift). Fall back to install so the
    // session is never blocked - but flag it, since a silent fallback would
    // hide a lockfile that's out of sync with package.json.
    drifted = true;
    installedVia = "npm install";
    try {
      run(["install", "--no-audit", "--no-fund"]);
    } catch {
      return; // give up quietly - don't block the session
    }
  }

  addContext(
    `Installed npm dev dependencies via ${installedVia} (node_modules was missing or stale - likely a fresh worktree or clone).` +
      (drifted
        ? " Note: `npm ci` failed, so this fell back to `npm install`; package-lock.json may be out of sync - run `npm install` and commit the updated lockfile."
        : "") +
      " `npm run test:skills` and `test:hooks` are ready to run.",
  );
}

main().catch(() => {});
