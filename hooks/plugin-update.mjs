// SessionStart + SessionEnd: prepare updates for the next session without
// blocking the current one. A detached Node worker serializes each host's
// refresh/install pair; command failures remain visible in its log.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, renameSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = dirname(dirname(SCRIPT));
const INTERVAL_MS = 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60_000;
const LOCK_MAX_AGE_MS = 10 * 60 * 1000;
const PLUGIN_REF = "incubator-build@incubator";
const CODEX_SETUP = "codex plugin marketplace add the-incubator/incubator-build-plugin --ref main && codex plugin add incubator-build@incubator";

function canonicalPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function detectHost(env = process.env, pluginRoot = PLUGIN_ROOT, home = homedir()) {
  const codexHome = resolve(env.CODEX_HOME || join(home, ".codex"));
  const cacheRelative = relative(canonicalPath(join(codexHome, "plugins", "cache")), canonicalPath(pluginRoot));
  const inCodexCache = cacheRelative !== "" && !cacheRelative.startsWith("..") && !cacheRelative.startsWith("/");
  // CODEX_HOME alone can be inherited by Claude launched from Codex. Require
  // this installation's cache location or Codex's own per-plugin root binding.
  const codexRootBinding = env.PLUGIN_ROOT && canonicalPath(env.PLUGIN_ROOT) === canonicalPath(pluginRoot)
    && (env.CODEX_HOME || env.CODEX_THREAD_ID);
  return inCodexCache || codexRootBinding ? "codex" : "claude";
}

export function updatePaths(host, env = process.env, home = homedir()) {
  const base = host === "codex"
    ? resolve(env.CODEX_HOME || join(home, ".codex"))
    : resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  const state = join(base, "incubator");
  return {
    state,
    stamp: join(state, "last-update-check"),
    lock: join(state, "plugin-update.lock"),
    log: join(state, "logs", "plugin-update.log"),
  };
}

export function updateCommands(host) {
  if (host === "codex") return [
    ["codex", ["plugin", "marketplace", "upgrade", "incubator"]],
    ["codex", ["plugin", "add", PLUGIN_REF]],
  ];
  if (host === "claude") return [
    ["claude", ["plugin", "marketplace", "update", "incubator"]],
    ["claude", ["plugin", "update", PLUGIN_REF]],
  ];
  throw new Error(`Unsupported plugin host: ${host}`);
}

function execute(command, args, env) {
  // Argument arrays avoid shell interpolation of paths and inherited values.
  return spawnSync(command, args, {
    env, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Filesystem primitives the lock uses, isolated so tests can drive the
// concurrent-worker interleavings deterministically.
const realLockOps = {
  mkdir: (path) => mkdirSync(path),
  stat: (path) => statSync(path),
  rename: (from, to) => renameSync(from, to),
  rm: (path, opts) => rmSync(path, opts),
};

function claimLock(lock, ops) {
  // mkdir is atomic: it fails with EEXIST if the directory already exists, so a
  // successful mkdir IS exclusive ownership. This is the ONLY way to acquire.
  try {
    ops.mkdir(lock);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
}

function reclaimStaleLock(lock, now, maxAgeMs, ops) {
  // Returns true when the lock path is free to re-claim, false to back off.
  // Reaps only a genuinely stale lock, and never removes the live path with a
  // blind rmSync -- it renames the directory to a private name first, so only
  // one worker can ever remove a given lock (the losers see ENOENT and just
  // re-claim). Whoever wins the rename then confirms the directory really was
  // stale; if it turned fresh between the age check and the rename (a worker
  // acquired in that window), it is restored and this caller backs off.
  let ageMs;
  try {
    ageMs = now - ops.stat(lock).mtimeMs;
  } catch (err) {
    if (err.code === "ENOENT") return true; // vanished on its own; re-claim.
    throw err;
  }
  if (ageMs <= maxAgeMs) return false; // a live worker holds it.
  const held = `${lock}.stale-${process.pid}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    ops.rename(lock, held);
  } catch (err) {
    if (err.code === "ENOENT") return true; // lost the rename race; re-claim.
    throw err;
  }
  try {
    if (now - ops.stat(held).mtimeMs <= maxAgeMs) {
      // We renamed away a lock that was actually fresh. Put it back if the path
      // is still free; otherwise drop our copy. Either way, do not proceed.
      try { ops.rename(held, lock); } catch { try { ops.rm(held, { recursive: true, force: true }); } catch {} }
      return false;
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    ops.rm(held, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return true;
}

export function acquireLock(lock, { now = Date.now(), maxAgeMs = LOCK_MAX_AGE_MS, ops = realLockOps } = {}) {
  // The maximum worker time is three bounded CLI calls, so any lock far older
  // than that window was stranded by an interrupted worker and is safe to reap.
  if (claimLock(lock, ops)) return true;
  if (!reclaimStaleLock(lock, now, maxAgeMs, ops)) return false;
  return claimLock(lock, ops);
}

export function runUpdate({ host, force = false, env = process.env, home = homedir(), run = execute, now = Date.now() }) {
  const commands = updateCommands(host);
  const paths = updatePaths(host, env, home);
  mkdirSync(dirname(paths.log), { recursive: true });
  if (!acquireLock(paths.lock, { now })) return { status: "busy" };
  try {
    let last = 0;
    try { last = Number(readFileSync(paths.stamp, "utf8")); } catch {}
    if (!force && last > 0 && now >= last && now - last < INTERVAL_MS) return { status: "throttled" };
    // Throttle attempts, including failed network/auth checks, to avoid retry
    // storms on every SessionStart/SessionEnd. --force bypasses the interval.
    writeFileSync(paths.stamp, String(now));
    writeFileSync(paths.log, `[plugin-update]\nhost: ${host}\nstarted_at: ${new Date(now).toISOString()}\n`);
    const log = (line) => appendFileSync(paths.log, line + "\n");
    const call = (command, args) => {
      log(`> ${command} ${args.join(" ")}`);
      const result = run(command, args, env);
      if (result.stdout) log(result.stdout.trimEnd());
      if (result.stderr) log(result.stderr.trimEnd());
      if (result.error || result.status !== 0) {
        throw new Error(`${command} failed (${result.error?.message || result.signal || result.status})`);
      }
      return result.stdout;
    };
    try {
      if (host === "codex") {
        const listing = JSON.parse(call("codex", ["plugin", "marketplace", "list", "--json"]));
        const marketplace = listing.marketplaces?.find((entry) => entry.name === "incubator");
        if (marketplace?.marketplaceSource?.sourceType !== "git") {
          log(`Skipped: incubator is not a configured Git marketplace. Local development sources are left in place. To switch to stable: ${CODEX_SETUP}`);
          return { status: "not-git" };
        }
      }
      for (const [command, args] of commands) call(command, args);
      log("Updated. Start a new session to load the installed version and review any new hook-trust prompt.");
      return { status: "updated" };
    } catch (err) {
      log(`Update failed: ${err.message}`);
      log(host === "codex"
        ? "Check Git credentials and Codex CLI compatibility; then run: node hooks/plugin-update.mjs --host codex --force (from the plugin checkout)."
        : "Check Claude CLI access and marketplace credentials, then retry the update.");
      return { status: "failed", error: err.message };
    }
  } finally {
    rmSync(paths.lock, { recursive: true, force: true });
  }
}

export function main(args = process.argv.slice(2)) {
  const hostIndex = args.indexOf("--host");
  const host = hostIndex < 0 ? detectHost() : args[hostIndex + 1];
  const force = args.includes("--force");
  try {
    updateCommands(host); // Validate before spawning anything.
    if (process.env.INCUBATOR_PLUGIN_UPDATE_DISABLED === "1") return 0;
    if (force || args.includes("--run")) {
      const result = runUpdate({ host, force });
      if (force) process.stdout.write(`Incubator update: ${result.status}. Log: ${updatePaths(host).log}\n`);
      return ["failed", "not-git", "busy"].includes(result.status) && force ? 1 : 0;
    }
    const child = spawn(process.execPath, [SCRIPT, "--run", "--host", host], {
      detached: true, stdio: "ignore", env: process.env,
    });
    child.on("error", (err) => {
      try {
        const paths = updatePaths(host);
        mkdirSync(dirname(paths.log), { recursive: true });
        appendFileSync(paths.log, `Worker launch failed: ${err.message}\n`);
      } catch {}
    });
    child.unref();
    return 0;
  } catch (err) {
    // Hook failures must not block sessions; explicit manual updates report a
    // failing exit status so operators don't mistake a failed attempt for success.
    process.stderr.write(`Incubator updater: ${err.message}\n`);
    return force ? 1 : 0;
  }
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(SCRIPT)) process.exitCode = main();
