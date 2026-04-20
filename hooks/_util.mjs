// Shared utilities for hook scripts. Vanilla ESM — no npm deps.
// All file I/O + HTTP is fail-soft: errors are logged and swallowed so Claude Code sessions are never blocked.

import { readFile, writeFile, mkdir, appendFile, readdir, unlink, rm, stat } from "node:fs/promises";
import { existsSync, createReadStream, createWriteStream, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { redactLine, mergeCounts } from "./redact.mjs";

const claudeDir = join(homedir(), ".claude");

// Plugin version is sourced from the plugin's own manifest — stays accurate
// across Claude Code's plugin updates without any installer involvement.
export const PLUGIN_VERSION = (() => {
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const manifestPath = join(here, "..", ".claude-plugin", "plugin.json");
    return JSON.parse(readFileSync(manifestPath, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

export const P = {
  claudeDir,
  incubator: join(claudeDir, "incubator"),
  credentials: join(claudeDir, "incubator", "credentials.json"),
  disabledFlag: join(claudeDir, "incubator", "disabled.flag"),
  sessionsDir: join(claudeDir, "incubator", "sessions"),
  spoolFor: (sessionId) => join(claudeDir, "incubator", "sessions", `${sessionId}.ndjson`),
  projectsDir: join(claudeDir, "projects"),
  uploadedTranscriptsLog: join(claudeDir, "incubator", "uploaded-transcripts.txt"),
  transcriptStagingDir: join(claudeDir, "incubator", "transcript-staging"),
  logsDir: join(claudeDir, "incubator", "logs"),
  transcriptSyncLog: join(claudeDir, "incubator", "logs", "transcript-sync.log"),
};

export async function readCreds() {
  if (!existsSync(P.credentials)) return null;
  try {
    return JSON.parse(await readFile(P.credentials, "utf8"));
  } catch {
    return null;
  }
}

export async function writeCreds(next) {
  await mkdir(P.incubator, { recursive: true, mode: 0o700 });
  await writeFile(P.credentials, JSON.stringify(next, null, 2), { mode: 0o600 });
}

export function hash16(salt, value) {
  if (value == null) return null;
  const h = createHash("sha256");
  h.update(salt);
  h.update(String(value));
  return h.digest("hex").slice(0, 16);
}

export function isDisabled() {
  return existsSync(P.disabledFlag);
}

export async function writeDisabled(reason) {
  await mkdir(P.incubator, { recursive: true });
  await writeFile(P.disabledFlag, JSON.stringify({ reason, since: new Date().toISOString() }));
}

export async function clearDisabled() {
  if (existsSync(P.disabledFlag)) await unlink(P.disabledFlag).catch(() => {});
}

export async function readStdinJson(timeoutMs = 1_000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let buf = "";
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(buf ? JSON.parse(buf) : null);
      } catch {
        resolve(null);
      }
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export async function postJson(url, body, { apiKey, timeoutMs = 3_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { ok: res.ok, status: res.status, body: json };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function appendSpool(sessionId, line) {
  await mkdir(P.sessionsDir, { recursive: true });
  await appendFile(P.spoolFor(sessionId), JSON.stringify(line) + "\n");
}

export async function readSpool(sessionId) {
  const f = P.spoolFor(sessionId);
  if (!existsSync(f)) return [];
  const raw = await readFile(f, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function deleteSpool(sessionId) {
  const f = P.spoolFor(sessionId);
  if (existsSync(f)) await rm(f, { force: true });
}

export async function listSpools() {
  if (!existsSync(P.sessionsDir)) return [];
  return (await readdir(P.sessionsDir))
    .filter((n) => n.endsWith(".ndjson"))
    .map((n) => n.replace(/\.ndjson$/, ""));
}

export function newSessionId() {
  return randomUUID();
}

export function resolveSessionId(payload) {
  return payload?.session_id ?? payload?.sessionId ?? process.env.CLAUDE_SESSION_ID ?? null;
}

// ── Transcript capture helpers ─────────────────────────────────────────────

// Find Claude Code's raw session transcript file by sessionId.
// Claude Code stores transcripts at ~/.claude/projects/<project-hash>/<sessionId>.jsonl.
export async function findTranscriptFile(sessionId) {
  if (!existsSync(P.projectsDir)) return null;
  const projectDirs = await readdir(P.projectsDir).catch(() => []);
  for (const pd of projectDirs) {
    const candidate = join(P.projectsDir, pd, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function loadUploadedTranscripts() {
  if (!existsSync(P.uploadedTranscriptsLog)) return new Set();
  try {
    const raw = await readFile(P.uploadedTranscriptsLog, "utf8");
    return new Set(raw.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function markTranscriptUploaded(sessionId) {
  await mkdir(P.incubator, { recursive: true });
  const existing = await loadUploadedTranscripts();
  if (existing.has(sessionId)) return;
  await appendFile(P.uploadedTranscriptsLog, `${sessionId}\n`);
}

export async function gzipAndHash(srcPath, dstPath) {
  await mkdir(P.transcriptStagingDir, { recursive: true });
  await pipeline(createReadStream(srcPath), createGzip({ level: 6 }), createWriteStream(dstPath));

  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const s = createReadStream(dstPath);
    s.on("data", (c) => hash.update(c));
    s.on("end", resolve);
    s.on("error", reject);
  });
  const size = (await stat(dstPath)).size;
  return { sha256: hash.digest("hex"), size };
}

// One-pass redact + gzip + sha256. Streams line-by-line so transcripts of any size stay
// bounded in memory. Returns both the gzipped output size and aggregated redaction counts.
export async function redactGzipAndHash(srcPath, dstPath) {
  await mkdir(P.transcriptStagingDir, { recursive: true });

  const counts = Object.create(null);
  const rl = createInterface({
    input: createReadStream(srcPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  async function* redactedLines() {
    for await (const line of rl) {
      const { text, counts: lineCounts } = redactLine(line);
      mergeCounts(counts, lineCounts);
      yield text + "\n";
    }
  }

  const hash = createHash("sha256");
  const gzip = createGzip({ level: 6 });
  gzip.on("data", (chunk) => hash.update(chunk));

  await pipeline(Readable.from(redactedLines()), gzip, createWriteStream(dstPath));

  const size = (await stat(dstPath)).size;
  return { sha256: hash.digest("hex"), size, redactionCounts: counts };
}

// Discover sessionIds present on disk (from Claude Code's projects dir).
export async function listOnDiskSessions() {
  if (!existsSync(P.projectsDir)) return [];
  const out = [];
  const projectDirs = await readdir(P.projectsDir).catch(() => []);
  for (const pd of projectDirs) {
    const entries = await readdir(join(P.projectsDir, pd)).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) out.push(entry.replace(/\.jsonl$/, ""));
    }
  }
  return out;
}

// Whitelist-strip a payload — never copy user content. Return a flat sanitized record.
//
// Claude Code hook payloads only expose tool identity + structured metadata:
//   - PreToolUse:  { tool_name, tool_input }
//   - PostToolUse: { tool_name, tool_input, tool_response }
//   - UserPromptSubmit: { prompt }
// So we extract the low-cardinality identifiers inside tool_input/tool_response
// (which tool was run, which skill/subagent, did it error, bash exit code) and
// discard the free-text fields (prompts, commands, file paths, descriptions).
export function sanitize(eventName, payload, salt) {
  const safe = {
    event_name: eventName,
    occurred_at: new Date().toISOString(),
  };
  if (!payload || typeof payload !== "object") return safe;

  // Permission mode applies to every hook — "default", "acceptEdits", "plan",
  // or "bypassPermissions". High-signal autonomy indicator.
  if (typeof payload.permission_mode === "string") {
    safe.permission_mode = payload.permission_mode;
  }

  // SessionStart source — "startup", "resume", "clear", or "compact".
  if (eventName === "SessionStart" && typeof payload.source === "string") {
    safe.session_source = payload.source;
  }

  // PreCompact trigger — "manual" or "auto".
  if (eventName === "PreCompact" && typeof payload.trigger === "string") {
    safe.compact_trigger = payload.trigger;
  }

  // Notification — bucket the message text into a category rather than store it.
  if (eventName === "Notification" && typeof payload.message === "string") {
    safe.notification_category = categorizeNotification(payload.message);
  }

  const tool = payload.tool_name ?? payload.tool ?? null;
  if (tool) safe.tool_name = String(tool);

  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null;
  const response = payload.tool_response && typeof payload.tool_response === "object" ? payload.tool_response : null;

  // Skill tool → which skill was invoked (e.g. "superpowers:using-superpowers").
  if (safe.tool_name === "Skill" && input?.skill) {
    safe.skill_name = String(input.skill);
  }

  // Task tool → which subagent was dispatched, and how long the dispatch prompt was.
  if (safe.tool_name === "Task") {
    if (input?.subagent_type) safe.subagent_type = String(input.subagent_type);
    if (typeof input?.prompt === "string") safe.prompt_length = input.prompt.length;
  }

  // File-touching tools → just the extension, never the path.
  if (input?.file_path && (safe.tool_name === "Read" || safe.tool_name === "Write" || safe.tool_name === "Edit")) {
    const ext = extFromPath(input.file_path);
    if (ext) safe.file_ext = ext;
  }

  // TodoWrite → how many todos (count only, no text).
  if (safe.tool_name === "TodoWrite" && Array.isArray(input?.todos)) {
    safe.todo_count = input.todos.length;
  }

  // WebFetch → hostname only. URL path and query stay out.
  if (safe.tool_name === "WebFetch" && typeof input?.url === "string") {
    const host = hostFromUrl(input.url);
    if (host) safe.url_domain = host;
  }

  // Bash tool → exit code surfaces on PostToolUse.
  if (safe.tool_name === "Bash" && response && Number.isFinite(response.exit_code)) {
    safe.exit_code = Number(response.exit_code);
  }

  // Any tool that failed — `is_error` is a boolean, not content.
  if (response?.is_error === true) {
    safe.error_class = "tool_error";
  }

  // UserPromptSubmit → size metric, not the prompt itself.
  if (eventName === "UserPromptSubmit" && typeof payload.prompt === "string") {
    safe.prompt_length = payload.prompt.length;
  }

  const cwd = payload.cwd ?? process.cwd();
  safe.project_id_hash = hash16(salt, cwd);

  return safe;
}

function extFromPath(p) {
  const s = String(p);
  const base = s.slice(s.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot).toLowerCase().slice(0, 16);
}

function hostFromUrl(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function categorizeNotification(message) {
  const m = message.toLowerCase();
  if (m.includes("permission") || m.includes("approve") || m.includes("allow")) return "permission-request";
  if (m.includes("waiting") && m.includes("input")) return "waiting-input";
  if (m.includes("idle")) return "idle";
  return "other";
}
