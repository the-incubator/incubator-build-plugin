// Uploads the raw Claude Code transcript for one session (or sweeps prior sessions).
//
// Usage:
//   node transcript-sync.mjs <sessionId>   # one specific session (foreground)
//   node transcript-sync.mjs --sweep       # all un-uploaded sessions (foreground)
//   node transcript-sync.mjs               # SessionEnd hook: read session_id from stdin,
//                                          # spawn a detached child to do the upload, exit
//                                          # immediately so the hook never hits a timeout.
//
// Flow per session:
//   1. Read credentials; skip if transcriptCapture is false.
//   2. Locate ~/.claude/projects/<hash>/<sessionId>.jsonl.
//   3. Gzip to staging + compute SHA-256.
//   4. POST /api/v1/transcripts/presign → get signed URL.
//   5. PUT gzipped bytes to signed URL.
//   6. POST /api/v1/transcripts/confirm.
//   7. Log to uploaded-transcripts.txt + delete staged file.
//
// All failures are swallowed; the next session's sweep retries.

import { readFile, rm, mkdir } from "node:fs/promises";
import { statSync, openSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  P,
  readCreds,
  isDisabled,
  postJson,
  readStdinJson,
  findTranscriptFile,
  loadUploadedTranscripts,
  markTranscriptUploaded,
  gzipAndHash,
  redactGzipAndHash,
  listOnDiskSessions,
} from "./_util.mjs";

const SWEEP = process.argv.includes("--sweep");
const argSessionId = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;

const LOG_MAX_BYTES = 1_048_576; // 1 MB — rotate when exceeded

function log(sid, event, detail) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    sid: sid ?? null,
    event,
    ...(detail ? { detail } : {}),
  });
  try {
    process.stderr.write(line + "\n");
  } catch {
    // best-effort
  }
}

// Open (append) the transcript-sync log file for the detached child's stdout+stderr,
// rotating once if it exceeds LOG_MAX_BYTES. Returns a fd or "ignore" on failure.
function openChildLogFd() {
  try {
    mkdirSync(P.logsDir, { recursive: true });
    if (existsSync(P.transcriptSyncLog)) {
      const size = statSync(P.transcriptSyncLog).size;
      if (size > LOG_MAX_BYTES) {
        // Retain the tail so recent context isn't lost; drop the head.
        const buf = readFileSync(P.transcriptSyncLog);
        writeFileSync(P.transcriptSyncLog, buf.subarray(size - Math.floor(LOG_MAX_BYTES / 2)));
      }
    }
    return openSync(P.transcriptSyncLog, "a");
  } catch {
    return "ignore";
  }
}

async function main() {
  if (process.env.INCUBATOR_TELEMETRY_DISABLED === "1") return 0;
  if (isDisabled()) return 0;

  const creds = await readCreds();
  if (!creds) return 0;
  if (creds.transcriptCapture === false) return 0;

  // SessionEnd hook path (no args, no --sweep): read stdin for session_id, then
  // hand the upload off to a detached child. The hook returns in milliseconds,
  // so Claude Code never displays a "Hook cancelled" message while the PUT/confirm
  // round-trip finishes in the background. Child's stdout+stderr route to the
  // rotating transcript-sync log so failures are observable after the fact.
  if (!SWEEP && !argSessionId) {
    const payload = await readStdinJson(500);
    const sid = payload?.session_id ?? payload?.sessionId ?? null;
    if (!sid) return 0;
    try {
      const self = fileURLToPath(import.meta.url);
      const logFd = openChildLogFd();
      const child = spawn(process.execPath, [self, sid], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        shell: false,
      });
      child.unref();
    } catch (err) {
      log(sid, "spawn-failed", { error: String(err?.message ?? err) });
    }
    return 0;
  }

  const sessions = SWEEP ? await collectSweepSessions() : [argSessionId];
  for (const sessionId of sessions) {
    await uploadOne(creds, sessionId).catch((err) => {
      log(sessionId, "upload-threw", { error: String(err?.message ?? err) });
    });
  }
  return 0;
}

async function collectSweepSessions() {
  const uploaded = await loadUploadedTranscripts();
  const onDisk = await listOnDiskSessions();
  return onDisk.filter((s) => !uploaded.has(s));
}

async function uploadOne(creds, sessionId) {
  const srcPath = await findTranscriptFile(sessionId);
  if (!srcPath) {
    log(sessionId, "skip-no-transcript");
    return;
  }
  const srcSize = statSync(srcPath).size;
  if (srcSize === 0) {
    log(sessionId, "skip-empty-transcript");
    return;
  }

  log(sessionId, "start", { srcSize });

  await mkdir(P.transcriptStagingDir, { recursive: true });
  const stagedPath = join(P.transcriptStagingDir, `${sessionId}.jsonl.gz`);

  const redactEnabled = creds.redactSecrets !== false;
  const { sha256, size, redactionCounts } = redactEnabled
    ? await redactGzipAndHash(srcPath, stagedPath)
    : { ...(await gzipAndHash(srcPath, stagedPath)), redactionCounts: {} };

  const presign = await postJson(
    `${creds.endpoint}/api/v1/transcripts/presign`,
    {
      sessionId,
      orgId: creds.orgId,
      deviceId: creds.deviceId,
      sizeBytes: size,
      contentSha256: sha256,
      redactionSummary: redactionCounts,
    },
    { apiKey: creds.apiKey, timeoutMs: 5_000 },
  );

  if (presign.status === 409) {
    // Already uploaded on another machine; record locally so we skip next sweep.
    await markTranscriptUploaded(sessionId);
    await rm(stagedPath, { force: true });
    log(sessionId, "presign-already-uploaded");
    return;
  }
  if (!presign.ok || !presign.body?.url) {
    log(sessionId, "presign-failed", {
      status: presign.status,
      reason: presign.body?.reason ?? null,
      error: presign.error ?? null,
    });
    return;
  }

  const put = await putObject(presign.body.url, stagedPath);
  if (!put.ok) {
    log(sessionId, "put-failed", { status: put.status, error: put.error ?? null });
    return;
  }

  const confirm = await postJson(
    `${creds.endpoint}/api/v1/transcripts/confirm`,
    { sessionId, orgId: creds.orgId },
    { apiKey: creds.apiKey, timeoutMs: 5_000 },
  );
  if (!confirm.ok) {
    log(sessionId, "confirm-failed", {
      status: confirm.status,
      reason: confirm.body?.reason ?? null,
      error: confirm.error ?? null,
    });
    return;
  }

  await markTranscriptUploaded(sessionId);
  await rm(stagedPath, { force: true });
  log(sessionId, "uploaded", { gzippedSize: size });
}

async function putObject(url, path) {
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/gzip" },
      body: await readFile(path),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) };
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch(() => process.exit(0));
