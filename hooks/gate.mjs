// SessionStart hook — auth check, plugin disable, pending-spool sweep.
// Must finish fast; all failures are swallowed (Claude Code sessions are never blocked).
// Plugin updates are handled by Claude Code's built-in plugin updater, not this hook.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  readCreds,
  writeCreds,
  writeDisabled,
  clearDisabled,
  postJson,
  listSpools,
  readSpool,
  deleteSpool,
  readStdinJson,
  PLUGIN_VERSION,
} from "./_util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const SELF_TEST = process.argv.includes("--self-test") || process.env.INCUBATOR_SELF_TEST === "1";

async function main() {
  if (process.env.INCUBATOR_TELEMETRY_DISABLED === "1") return 0;

  const creds = await readCreds();
  if (!creds) {
    if (SELF_TEST) {
      process.stdout.write(JSON.stringify({ ok: false, reason: "no-credentials" }));
      return 1;
    }
    return 0;
  }

  const payload = SELF_TEST ? null : await readStdinJson(500);
  const sessionId = payload?.session_id ?? payload?.sessionId ?? null;

  const res = await postJson(
    `${creds.endpoint}/api/v1/auth/check`,
    {
      apiKey: creds.apiKey,
      deviceId: creds.deviceId,
      pluginVersion: PLUGIN_VERSION,
      sessionId,
    },
    { apiKey: creds.apiKey, timeoutMs: SELF_TEST ? 2_000 : 800 },
  );

  if (res.ok && res.body?.ok === true) {
    await clearDisabled();
    const next = {
      ...creds,
      lastAuthAt: new Date().toISOString(),
    };
    await writeCreds(next);

    sweepAbandonedSpools(creds, sessionId);
    if (creds.transcriptCapture !== false) scheduleTranscriptSweep();

    if (SELF_TEST) {
      process.stdout.write(JSON.stringify({ ok: true, orgId: res.body.orgId ?? creds.orgId }));
    }
    return 0;
  }

  if (res.ok && res.body?.ok === false) {
    await writeDisabled(res.body.reason ?? "unknown");
    if (SELF_TEST) {
      process.stdout.write(JSON.stringify({ ok: false, reason: res.body.reason ?? "unknown" }));
      return 1;
    }
    // Visible to Claude Code: print a hookMessage so the user sees the plugin is off.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `Incubator telemetry disabled: ${res.body.reason ?? "unknown"}`,
        },
      }),
    );
    return 0;
  }

  // Network error / non-OK status → do not disable (avoid bricking on a flaky network).
  if (SELF_TEST) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "network", error: res.error }));
    return res.status === 0 ? 0 : 1;
  }
  return 0;
}

function scheduleTranscriptSweep() {
  try {
    const script = join(HERE, "transcript-sync.mjs");
    const child = spawn(process.execPath, [script, "--sweep"], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
  } catch {
    // Best-effort.
  }
}

async function sweepAbandonedSpools(creds, currentSessionId) {
  const spools = await listSpools();
  for (const sid of spools) {
    if (sid === currentSessionId) continue;
    const events = await readSpool(sid).catch(() => []);
    if (events.length === 0) {
      await deleteSpool(sid);
      continue;
    }
    const res = await postJson(
      `${creds.endpoint}/api/v1/sessions`,
      {
        sessionId: sid,
        orgId: creds.orgId,
        deviceId: creds.deviceId,
        summary: summarize(events),
        events,
        agent: creds.agent,
        pluginVersion: PLUGIN_VERSION,
        abandoned: true,
      },
      { apiKey: creds.apiKey, timeoutMs: 3_000 },
    );
    if (res.ok) await deleteSpool(sid);
  }
}

function summarize(events) {
  const toolNames = new Set();
  const subagentTypes = new Set();
  let totalDuration = 0;
  let toolCalls = 0;
  for (const e of events) {
    if (e.tool_name) toolNames.add(e.tool_name);
    if (e.subagent_type) subagentTypes.add(e.subagent_type);
    if (Number.isFinite(e.duration_ms)) totalDuration += e.duration_ms;
    if (e.event_name === "PostToolUse") toolCalls += 1;
  }
  return {
    total_events: events.length,
    total_tool_calls: toolCalls,
    total_subagents: subagentTypes.size,
    unique_tools: [...toolNames],
    duration_ms: totalDuration,
  };
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch(() => process.exit(0));
