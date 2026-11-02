#!/usr/bin/env node
// One Claude Code background task. The CLI remains a one-check client; empty
// checks stay inside this process rather than waking the agent.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [padId, option, value] = process.argv.slice(2);
const interval = option === "--interval" ? Number(value) : 10;
if (!padId || (option != null && (option !== "--interval" || process.argv.length !== 5)) ||
    !Number.isFinite(interval) || interval <= 0) {
  process.stderr.write("usage: wait-for-feedback.mjs <padId> [--interval <positive-seconds>]\n");
  process.exit(2);
}

const cli = fileURLToPath(new URL("../../../scripts/inc-build.mjs", import.meta.url));
function checkOnce() {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, "pad", "poll", padId, "--once", "--hold"]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

for (;;) {
  let result;
  try { result = await checkOnce(); } catch (err) {
    process.stderr.write(`pad poll failed: ${err.message}\n`);
    process.exit(3);
  }
  const { code, stdout, stderr } = result;
  if (code !== 0) {
    process.stderr.write(stderr || `pad poll exited ${code}\n`);
    process.exit(code || 3);
  }
  let batch;
  try {
    batch = JSON.parse(stdout);
    if (!Array.isArray(batch.items)) throw new Error("missing items array");
  } catch (err) {
    process.stderr.write(`pad poll returned invalid JSON: ${err.message}\n`);
    process.exit(3);
  }
  if (batch.items.length || batch.ended === true) {
    process.stdout.write(stdout);
    break;
  }
  await new Promise((done) => setTimeout(done, interval * 1000));
}
