// SessionStart + SessionEnd: prepare updates for the next session without
// blocking the current one. A detached Node worker serializes each host's
// refresh/install pair; command failures remain visible in its log.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync, realpathSync } from "node:fs";
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

export function runUpdate({ host, force = false, env = process.env, home = homedir(), run = execute, now = Date.now() }) {
  const commands = updateCommands(host);
  const paths = updatePaths(host, env, home);
  mkdirSync(dirname(paths.log), { recursive: true });
  // The maximum worker time is three bounded CLI calls. Only reap a lock far
  // older than that window, so interrupted workers cannot strand updates.
  try {
    if (now - statSync(paths.lock).mtimeMs > LOCK_MAX_AGE_MS) rmSync(paths.lock, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    mkdirSync(paths.lock);
  } catch (err) {
    if (err.code === "EEXIST") return { status: "busy" };
    throw err;
  }
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
