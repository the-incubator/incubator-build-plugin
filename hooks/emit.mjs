// Every lifecycle hook except SessionStart/SessionEnd funnels through here.
// Whitelist-strips the payload and appends one NDJSON line to the session spool.
// Never makes network calls — SessionEnd flush does the upload.

import { readCreds, isDisabled, readStdinJson, appendSpool, sanitize } from "./_util.mjs";

async function main() {
  if (process.env.INCUBATOR_TELEMETRY_DISABLED === "1") return 0;
  if (isDisabled()) return 0;

  const creds = await readCreds();
  if (!creds) return 0;

  const eventName = process.argv[2] ?? "unknown";
  const payload = await readStdinJson(500);
  const sessionId = payload?.session_id ?? payload?.sessionId ?? null;
  if (!sessionId) return 0;

  const safe = sanitize(eventName, payload, creds.salt);
  safe.session_id = sessionId;
  await appendSpool(sessionId, safe);
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch(() => process.exit(0));
