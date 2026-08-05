// SessionStart + SessionEnd hook: background plugin auto-updater.
//
// Runs on both events so SessionEnd primes the update for the next start
// (plugin changes only take effect on the following session), and SessionStart
// acts as a fallback if SessionEnd didn't fire (killed terminal, crash).
// The stamp file dedups across both — concurrent sessions also serialize on it.
//
// Throttled to at most once per hour. Spawns `claude plugin update` fully
// detached so the running session is never blocked and the child outlives this
// hook process. Any failure is swallowed — Claude Code sessions must never be
// blocked by the updater.
//
// Debug: every run overwrites ~/.claude/incubator/logs/plugin-update.log with
// a header describing the decision, and the detached subprocess streams its
// own stdout/stderr into the same file so we can see exactly what failed.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { P } from "./_util.mjs";

const FALLBACK_MARKETPLACE = "incubator";
const PLUGIN_NAME = "incubator-build";

// Channel awareness: a marketplace install places this file at
// ~/.claude/plugins/cache/<marketplace>/<plugin>/hooks/plugin-update.mjs.
// Deriving the marketplace from our own path means the identical code
// self-updates from whichever channel it was installed from — "incubator"
// (stable, main) or "incubator-beta" (beta branch) — with no per-branch
// edits that a beta→main merge could leak. Local/dev installs don't match
// the cache layout and fall back to the stable channel names.
function deriveChannel() {
  try {
    const here = fileURLToPath(new URL(".", import.meta.url)); // .../<plugin>/hooks/
    const parts = here.split(sep).filter(Boolean);
    const cacheIdx = parts.lastIndexOf("cache");
    if (cacheIdx > 0 && parts[cacheIdx - 1] === "plugins" && parts.length > cacheIdx + 2) {
      const marketplace = parts[cacheIdx + 1];
      const plugin = parts[cacheIdx + 2];
      return { marketplace, pluginRef: `${plugin}@${marketplace}` };
    }
  } catch {}
  return { marketplace: FALLBACK_MARKETPLACE, pluginRef: `${PLUGIN_NAME}@${FALLBACK_MARKETPLACE}` };
}

const { marketplace: MARKETPLACE_NAME, pluginRef: PLUGIN_REF } = deriveChannel();
const INTERVAL_MS = 1 * 60 * 60 * 1000;
const STAMP_PATH = join(P.incubator, "last-update-check");
const LOG_PATH = join(P.logsDir, "plugin-update.log");

function log(header) {
  try {
    mkdirSync(P.logsDir, { recursive: true });
    writeFileSync(LOG_PATH, header);
  } catch {}
}

const startedAt = new Date().toISOString();
const now = Date.now();

try {
  let last = 0;
  try {
    const raw = readFileSync(STAMP_PATH, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) last = parsed;
  } catch {}

  const sinceMs = now - last;
  const throttled = last !== 0 && sinceMs < INTERVAL_MS;

  const which = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" });
  const whichStdout = (which.stdout ?? "").trim();
  const whichStderr = (which.stderr ?? "").trim();

  const header =
    `[plugin-update hook]\n` +
    `started_at:       ${startedAt}\n` +
    `channel:          ${MARKETPLACE_NAME} (${PLUGIN_REF})\n` +
    `last_check_epoch: ${last}\n` +
    `since_last_ms:    ${sinceMs}\n` +
    `interval_ms:      ${INTERVAL_MS}\n` +
    `throttled:        ${throttled}\n` +
    `PATH:             ${process.env.PATH ?? ""}\n` +
    `which claude:     ${whichStdout || "(not found)"}\n` +
    `which stderr:     ${whichStderr}\n` +
    `which exit:       ${which.status}\n` +
    `----- subprocess output below (if spawned) -----\n`;

  if (throttled) {
    log(header + `(skipped — throttled)\n`);
    process.exit(0);
  }

  mkdirSync(P.incubator, { recursive: true });
  writeFileSync(STAMP_PATH, String(now));
  log(header);

  // Open the log file for append so the detached subprocess can stream its
  // stdout+stderr directly into it. We close our fd after spawn — the child
  // keeps its own dup'd copy.
  const fd = openSync(LOG_PATH, "a");
  const child = spawn(
    "sh",
    [
      "-c",
      `echo "[spawn] pid=$$"; ` +
      `echo "[spawn] which claude: $(command -v claude)"; ` +
      `echo "[spawn] marketplace update ${MARKETPLACE_NAME}"; ` +
      `claude plugin marketplace update ${MARKETPLACE_NAME} 2>&1; ` +
      `echo "[spawn] plugin update ${PLUGIN_REF}"; ` +
      `claude plugin update ${PLUGIN_REF} 2>&1; ` +
      `echo "[spawn] done"`,
    ],
    { detached: true, stdio: ["ignore", fd, fd] },
  );
  child.unref();
  closeSync(fd);
} catch (err) {
  log(
    `[plugin-update hook]\n` +
    `started_at: ${startedAt}\n` +
    `fatal_error: ${String(err?.stack ?? err)}\n`,
  );
}

process.exit(0);
