// SessionEnd hook — batch-uploads the session spool to the backend in one POST.
// If the plugin is disabled, drops the spool instead of uploading.

import {
  readCreds,
  isDisabled,
  readStdinJson,
  readSpool,
  deleteSpool,
  postJson,
  PLUGIN_VERSION,
} from "./_util.mjs";

async function main() {
  if (process.env.INCUBATOR_TELEMETRY_DISABLED === "1") return 0;

  const creds = await readCreds();
  if (!creds) return 0;

  const payload = await readStdinJson(500);
  const sessionId = payload?.session_id ?? payload?.sessionId ?? null;
  if (!sessionId) return 0;

  if (isDisabled()) {
    await deleteSpool(sessionId);
    return 0;
  }

  const events = await readSpool(sessionId);
  if (events.length === 0) return 0;

  pairDurations(events);
  const summary = summarize(events);
  const body = {
    sessionId,
    orgId: creds.orgId,
    deviceId: creds.deviceId,
    agent: creds.agent,
    pluginVersion: PLUGIN_VERSION,
    exitReason: payload?.exit_reason ?? null,
    summary,
    events,
  };

  let uploaded = false;
  for (let attempt = 0; attempt < 2 && !uploaded; attempt++) {
    if (attempt > 0) await sleep(jitter(500));
    const res = await postJson(`${creds.endpoint}/api/v1/sessions`, body, {
      apiKey: creds.apiKey,
      timeoutMs: 3_000,
    });
    if (res.ok) uploaded = true;
  }
  if (uploaded) await deleteSpool(sessionId);
  return 0;
}

// Claude Code hooks emit PreToolUse and PostToolUse as separate events with no
// shared correlation ID — so we pair them here by "most recent open Pre for this
// tool" and stamp duration_ms on the Post. Tool calls aren't interleaved within a
// single agent, so this is accurate in practice; edge cases (missing Post,
// duplicated Pre) just leave duration_ms null rather than produce wrong numbers.
function pairDurations(events) {
  const openPre = new Map(); // tool_name -> occurred_at (ISO string)
  for (const e of events) {
    if (!e.tool_name || !e.occurred_at) continue;
    if (e.event_name === "PreToolUse") {
      openPre.set(e.tool_name, e.occurred_at);
    } else if (e.event_name === "PostToolUse") {
      const preAt = openPre.get(e.tool_name);
      if (preAt) {
        const ms = Date.parse(e.occurred_at) - Date.parse(preAt);
        if (Number.isFinite(ms) && ms >= 0) e.duration_ms = ms;
        openPre.delete(e.tool_name);
      }
    }
  }
}

function summarize(events) {
  const toolNames = new Set();
  const subagentTypes = new Set();
  let totalDuration = 0;
  let toolCalls = 0;
  let firstAt = null;
  let lastAt = null;
  for (const e of events) {
    if (e.tool_name) toolNames.add(e.tool_name);
    if (e.subagent_type) subagentTypes.add(e.subagent_type);
    if (Number.isFinite(e.duration_ms)) totalDuration += e.duration_ms;
    if (e.event_name === "PostToolUse") toolCalls += 1;
    if (e.occurred_at) {
      if (!firstAt || e.occurred_at < firstAt) firstAt = e.occurred_at;
      if (!lastAt || e.occurred_at > lastAt) lastAt = e.occurred_at;
    }
  }
  return {
    total_events: events.length,
    total_tool_calls: toolCalls,
    total_subagents: subagentTypes.size,
    unique_tools: [...toolNames],
    duration_ms: totalDuration,
    started_at: firstAt,
    ended_at: lastAt,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(base) {
  return base + Math.floor(Math.random() * base);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch(() => process.exit(0));
