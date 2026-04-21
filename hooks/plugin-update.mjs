// SessionStart hook: background plugin auto-updater.
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
import { join } from "node:path";
import { P } from "./_util.mjs";

const MARKETPLACE_NAME = "incubator";
const PLUGIN_REF = "incubator-build@incubator";
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
