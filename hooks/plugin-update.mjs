// SessionStart hook: background plugin auto-updater.
//
// Throttled to at most once per 6 hours. Spawns `claude plugin update` fully
// detached so the running session is never blocked and the child outlives this
// hook process. Any failure is swallowed — Claude Code sessions must never be
// blocked by the updater.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { P } from "./_util.mjs";

const MARKETPLACE_NAME = "incubator";
const PLUGIN_REF = "incubator-build@incubator";
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const STAMP_PATH = join(P.incubator, "last-update-check");

try {
  const now = Date.now();
  let last = 0;
  try {
    const raw = readFileSync(STAMP_PATH, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) last = parsed;
  } catch {}

  if (now - last < INTERVAL_MS) process.exit(0);

  mkdirSync(P.incubator, { recursive: true });
  writeFileSync(STAMP_PATH, String(now));

  // Detach: the child must not keep the hook (or the session) alive.
  const child = spawn(
    "sh",
    [
      "-c",
      `claude plugin marketplace update ${MARKETPLACE_NAME} --scope user >/dev/null 2>&1; ` +
      `claude plugin update ${PLUGIN_REF} --scope user >/dev/null 2>&1`,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
} catch {
  // Never block session start.
}

process.exit(0);
