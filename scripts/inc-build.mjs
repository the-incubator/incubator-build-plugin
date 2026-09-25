#!/usr/bin/env node
// inc-build - minimal CLI for the Incubator Build API, authenticated with
// the plugin's install-time credentials (~/.claude/incubator/credentials.json).
// Meant to be called by skills so they can read/write the build API without
// re-implementing auth.
//
// Usage:
//   inc-build get <path> [--query k=v ...]          # generic GET, prints JSON
//   inc-build feedback list [--project X] [--status submitted] [--preview <host>]
//   inc-build feedback get <sessionId>              # session + annotations
//   inc-build feedback fetch <sessionId> [--out <dir>]
//                                                       # download bundle + recording zip
//   inc-build pad create <file-or-dir> [--title <title>]   # publish an IncPad, prints share URL
//   inc-build pad update <padId> <file-or-dir>              # publish a new revision
//   inc-build pad poll <padId> [--interval <s>] [--timeout <s>] [--once]
//                                                       # short-poll for reviewer feedback
//   inc-build pad reply <padId> [--] <text...>              # reply in the pad's conversation panel
//   inc-build pad end <padId>                               # end the review
//   inc-build pad open <url>                                # open a URL in the host browser
//
// Auth: sends `Authorization: Bearer <apiKey>` from credentials.json. Errors are
// surfaced (non-zero exit) rather than swallowed, unlike the telemetry hooks.
// INCUBATOR_HOME overrides the config directory (credentials + per-pad cursors).

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";

const CONFIG_DIR = process.env.INCUBATOR_HOME || join(homedir(), ".claude", "incubator");
const CREDS_PATH = join(CONFIG_DIR, "credentials.json");
const PADS_DIR = join(CONFIG_DIR, "pads");

const die = (m, code = 1) => {
  process.stderr.write(`inc-build: ${m}\n`);
  process.exit(code);
};

function loadCreds() {
  let raw;
  try {
    raw = readFileSync(CREDS_PATH, "utf8");
  } catch {
    die(`no credentials at ${CREDS_PATH} - is the incubator-build plugin installed?`);
  }
  let c;
  try {
    c = JSON.parse(raw);
  } catch {
    die(`credentials.json is not valid JSON (${CREDS_PATH})`);
  }
  if (!c.apiKey || !c.endpoint) die("credentials.json is missing apiKey/endpoint");
  return c;
}

// Every request is bounded so a stalled server cannot hang a command forever.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

async function api(creds, method, path, { query, body, signal } = {}) {
  const base = creds.endpoint.replace(/\/$/, "");
  const qs = query
    ? "?" +
      Object.entries(query)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  let res;
  try {
    res = await fetch(`${base}${path}${qs}`, {
      method,
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ?? AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      die(`${method} ${path} timed out waiting for the server`, 3);
    }
    die(`${method} ${path} transport failed: ${err?.message ?? String(err)}`, 3);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const code = res.status === 404 ? 1 : res.status === 409 ? 2 : res.status === 401 || res.status === 403 ? 3 : 1;
    const detail = json.detail ?? json.message;
    die(`${method} ${path} failed (${res.status}): ${json.reason ?? "unknown"}${detail ? ` - ${detail}` : ""}`, code);
  }
  return json;
}

const BOOLEAN_FLAGS = new Set(["once", "reset", "unconsumed"]);

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--query") {
      const query = argv[++i];
      if (!query || query.startsWith("--")) die("--query requires k=v");
      const [k, ...v] = query.split("=");
      if (!k || !v.length) die("--query requires k=v");
      (flags.query ??= {})[k] = v.join("=");
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) && (!next || next.startsWith("--"))) {
        flags[key] = true;
      } else {
        if (!next || next.startsWith("--")) die(`${a} requires a value`);
        flags[key] = next;
        i++;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

const USAGE = `inc-build - Incubator Build API client (uses plugin install credentials)

  inc-build get <path> [--query k=v ...]
  inc-build feedback list [--project X] [--status submitted] [--preview <host>]
  inc-build feedback get <sessionId>
  inc-build feedback fetch <sessionId> [--out <dir>]
  inc-build feedback projects
  inc-build feedback mint-token --project <slug> [--label <name>] [--days <n>]
  inc-build pad create <file-or-dir> [--title <title>]
  inc-build pad update <padId> <file-or-dir>
  inc-build pad poll <padId> [--interval <seconds>] [--timeout <seconds>] [--once] [--after <cursor>] [--reset]
  inc-build pad reply <padId> [--] <text...>
  inc-build pad end <padId>
  inc-build pad open <url>
`;

function runCommand(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandError(result) {
  return result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
}

function openUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    die("pad open requires a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    die("pad open requires an http(s) URL");
  }

  // Match cmux-browser's gate: command present, live browser socket, and enabled panel.
  // Do not call cmux unless this complete check passes.
  const cmuxStatus = runCommand("cmux", ["browser-status"]);
  const liveCmux = cmuxStatus.status === 0 && (cmuxStatus.stdout ?? "").trim() !== "disabled";
  if (liveCmux) {
    const opened = runCommand("cmux", ["browser", "open", url]);
    if (opened.stdout) process.stdout.write(opened.stdout);
    if (opened.stderr) process.stderr.write(opened.stderr);
    if (opened.status !== 0) die(`cmux browser open failed: ${commandError(opened)}`);
    process.stderr.write(`opened in cmux browser: ${url}\n`);
    return;
  }

  // Claude and ChatGPT desktop do not expose a stable, host-independent browser
  // signal or navigation command. Do not infer either host from process names or env.
  const launcher = process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "darwin" ? ["-a", "Google Chrome", url] : [url];
  const opened = runCommand(launcher, args);
  if (opened.stdout) process.stdout.write(opened.stdout);
  if (opened.stderr) process.stderr.write(opened.stderr);
  if (opened.status !== 0) die(`${launcher} failed: ${commandError(opened)}`);
  process.stderr.write(`opened in ${process.platform === "darwin" ? "Google Chrome" : launcher}: ${url}\n`);
}

// --- IncPad -----------------------------------------------------------------

const CONTENT_TYPES = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain", ".md": "text/markdown",
  ".csv": "text/csv", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".pdf": "application/pdf", ".wasm": "application/wasm", ".map": "application/json",
};

function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// Symlinks are skipped (not followed): a link could point outside the artifact
// directory and publish a private file under an innocent-looking path, or loop.
function walkFiles(dir, root = dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      process.stderr.write(`inc-build: skipping symlink ${relative(root, full)} (links are not uploaded)\n`);
      continue;
    }
    if (st.isDirectory()) walkFiles(full, root, acc);
    else if (st.isFile()) acc.push(relative(root, full).split("\\").join("/"));
  }
  return acc;
}

function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

// A single .html file uploads inlined as index.html. A directory uploads its
// index.html plus every non-hidden file with a path relative to the directory.
function padPayload(input, title) {
  if (!input) die("pad create/update requires <file-or-dir>");
  const path = resolve(input);
  if (!existsSync(path)) die(`no such file or directory: ${input}`);
  const files = [];
  let html;
  if (statSync(path).isDirectory()) {
    const entry = join(path, "index.html");
    if (!existsSync(entry)) die(`${input} has no index.html at its root - a pad directory must contain one`);
    for (const rel of walkFiles(path)) {
      const buf = readFileSync(join(path, rel));
      if (rel === "index.html") html = buf.toString("utf8");
      files.push({ path: rel, content_base64: buf.toString("base64"), content_type: contentTypeFor(rel) });
    }
  } else {
    const ext = extname(path).toLowerCase();
    if (ext !== ".html" && ext !== ".htm") die(`${input} is not an .html file - pass an HTML file or a directory with index.html`);
    const buf = readFileSync(path);
    html = buf.toString("utf8");
    files.push({ path: "index.html", content_base64: buf.toString("base64"), content_type: "text/html" });
  }
  const resolvedTitle = title || htmlTitle(html ?? "") || basename(path, extname(path));
  return { title: resolvedTitle, entry: "index.html", files };
}

function padStatePath(id) {
  return join(PADS_DIR, `${encodeURIComponent(id)}.json`);
}

// Only a missing state file means "no state". Any other failure (corrupt JSON,
// permissions) is surfaced, so a broken file cannot silently rewind the cursor
// and re-deliver feedback the agent already handled.
function readPadState(id) {
  const path = padStatePath(id);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    die(`cannot read pad state ${path}: ${err?.message ?? String(err)}`, 4);
  }
  try {
    return JSON.parse(raw);
  } catch {
    die(`pad state ${path} is corrupt - fix or delete it (deleting re-delivers feedback from the start)`, 4);
  }
}

// Atomic write (temp file + rename) so an interrupted write never leaves a
// truncated JSON file behind.
function writePadState(id, patch) {
  mkdirSync(PADS_DIR, { recursive: true });
  const next = { ...readPadState(id), ...patch, updated_at: new Date().toISOString() };
  const path = padStatePath(id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, path);
  return next;
}

// After a remote mutation succeeded, a local bookkeeping failure must not look
// like an API failure (a retry would create a duplicate pad or reply).
function persistAfterMutation(id, patch) {
  try {
    writePadState(id, patch);
  } catch (err) {
    process.stderr.write(`inc-build: warning - the server accepted the request but local pad state was not saved (${err?.message ?? String(err)})\n`);
    process.exitCode = 4;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function numberFlag(flags, key, fallback) {
  if (flags[key] == null) return fallback;
  const n = Number(flags[key]);
  if (!Number.isFinite(n) || n < 0) die(`--${key} must be a non-negative number of seconds`);
  return n;
}

const PAD_FLAGS = {
  create: ["title"],
  update: ["title"],
  poll: ["interval", "timeout", "once", "after", "reset"],
  reply: [],
  end: [],
  open: [],
};

const PAD_USAGE = {
  create: "pad create <file-or-dir> [--title <title>]",
  update: "pad update <padId> <file-or-dir> [--title <title>]",
  poll: "pad poll <padId> [--interval <seconds>] [--timeout <seconds>] [--once] [--after <cursor>] [--reset]",
  reply: "pad reply <padId> [--] <text...>",
  end: "pad end <padId>",
  open: "pad open <url>",
};

// Exact positional arity, so a stray token never reaches the server as a mutation.
function requireArity(sub, rest, min, max = min) {
  if (rest.length < min || rest.length > max) {
    die(`usage: ${PAD_USAGE[sub]} (got ${rest.length} positional argument${rest.length === 1 ? "" : "s"})`, 2);
  }
}

function rejectUnknownFlags(sub, flags) {
  const allowed = new Set(PAD_FLAGS[sub] ?? []);
  const unknown = Object.keys(flags).filter((k) => !allowed.has(k));
  if (!unknown.length) return;
  const hint = allowed.size ? `valid flags: ${[...allowed].map((f) => `--${f}`).join(", ")}` : "this subcommand takes no flags";
  die(`pad ${sub}: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.map((f) => `--${f}`).join(", ")} (${hint})`, 2);
}

// Poll requests are capped so a hung server cannot outlive --timeout.
const POLL_REQUEST_CAP_MS = 30_000;

async function padCommand(creds, sub, rest, flags, out) {
  const padPath = (id, tail = "") => `/api/v1/pads/${encodeURIComponent(id)}${tail}`;
  rejectUnknownFlags(sub, flags);

  if (sub === "create") {
    requireArity("create", rest, 1);
    const body = padPayload(rest[0], flags.title);
    const result = await api(creds, "POST", "/api/v1/pads", { body });
    if (!result.url || !result.id) die("POST /api/v1/pads returned no pad id or URL");
    process.stdout.write(`${result.url}\npadId: ${result.id}\nrevision: ${result.revision ?? 1}\n`);
    persistAfterMutation(result.id, { title: body.title, share_id: result.share_id, url: result.url, revision: result.revision, cursor: null, pending: [] });
    return;
  }

  if (sub === "update") {
    requireArity("update", rest, 2);
    const id = rest[0];
    const body = padPayload(rest[1], flags.title || readPadState(id).title);
    const result = await api(creds, "PUT", padPath(id, "/revisions"), { body });
    if (result.revision == null) die("PUT /api/v1/pads/:id/revisions returned no revision - the update was not confirmed", 3);
    process.stdout.write(`revision: ${result.revision}\n`);
    if (result.url) process.stdout.write(`url: ${result.url}\n`);
    persistAfterMutation(id, { title: body.title, revision: result.revision, ...(result.url ? { url: result.url } : {}) });
    return;
  }

  if (sub === "poll") {
    requireArity("poll", rest, 1);
    const id = rest[0];
    const interval = numberFlag(flags, "interval", 10);
    const timeout = numberFlag(flags, "timeout", 540);
    const state = readPadState(id);
    // Delivery is durable: a fetched batch is saved as `pending` together with
    // the advanced cursor before it is printed, and cleared only after printing.
    // A poll killed between those steps replays the batch instead of losing it.
    const deliver = async (batch) => {
      const text = JSON.stringify(batch, null, 2) + "\n";
      await new Promise((resolveWrite, rejectWrite) => {
        process.stdout.write(text, (err) => (err ? rejectWrite(err) : resolveWrite()));
      }).catch((err) => die(`feedback batch kept for replay - stdout write failed: ${err?.message ?? String(err)}`, 4));
      writePadState(id, { pending: [] });
    };
    if (flags.reset) {
      writePadState(id, { cursor: null, pending: [] });
    } else if (Array.isArray(state.pending) && state.pending.length) {
      await deliver({ items: state.pending, cursor: state.cursor ?? null, replayed: true });
      return;
    }
    let cursor = flags.reset ? null : flags.after ?? state.cursor ?? null;
    const deadline = Date.now() + timeout * 1000;
    // Short polls only: each request returns immediately, so nothing holds a
    // server connection open between checks.
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        out({ items: [], cursor });
        return;
      }
      const result = await api(creds, "GET", padPath(id, "/feedback"), {
        query: { after: cursor },
        signal: AbortSignal.timeout(Math.max(1, Math.min(POLL_REQUEST_CAP_MS, remaining))),
      });
      const items = Array.isArray(result.items) ? result.items : [];
      const next = result.cursor ?? cursor;
      const ended = result.ended === true;
      if (items.length || ended) {
        cursor = next;
        writePadState(id, { cursor, pending: items, ...(ended ? { ended: true } : {}) });
        await deliver({ items, cursor, ...(ended ? { ended: true } : {}) });
        return;
      }
      cursor = next;
      if (cursor !== (readPadState(id).cursor ?? null)) writePadState(id, { cursor });
      if (flags.once || Date.now() + interval * 1000 > deadline) {
        out({ items: [], cursor });
        return;
      }
      await sleep(interval * 1000);
    }
  }

  if (sub === "reply") {
    requireArity("reply", rest, 2, Infinity);
    const id = rest[0];
    const text = rest.slice(1).join(" ").trim();
    if (!text) die(`usage: ${PAD_USAGE.reply}`, 2);
    const result = await api(creds, "POST", padPath(id, "/replies"), { body: { text } });
    if (result.id == null) die("POST /api/v1/pads/:id/replies returned no reply id - the reply was not confirmed", 3);
    process.stdout.write(`replyId: ${result.id}\n`);
    return;
  }

  if (sub === "end") {
    requireArity("end", rest, 1);
    const id = rest[0];
    const result = await api(creds, "POST", padPath(id, "/end"));
    if (result.ended !== true) die("POST /api/v1/pads/:id/end did not confirm ended: true", 3);
    process.stdout.write("ended: true\n");
    persistAfterMutation(id, { ended: true });
    return;
  }

  die("usage: pad ( create <file-or-dir> | update <padId> <file-or-dir> | poll <padId> | reply <padId> <text> | end <padId> | open <url> )");
}

async function main() {
  const [cmd, sub, ...tail] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const optionRegion = tail.includes("--") ? tail.slice(0, tail.indexOf("--")) : tail;
  if (sub === "-h" || sub === "--help" || optionRegion.includes("-h") || optionRegion.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const { flags, rest } = parseFlags(tail);
  if (cmd === "plan") {
    die("hosted plans moved to IncPad: use `inc-build pad create <file-or-dir>` (see the inc-pad skill)");
  }
  if (cmd === "pad" && sub === "open") {
    rejectUnknownFlags("open", flags);
    requireArity("open", rest, 1);
    openUrl(rest[0]);
    return;
  }
  const creds = loadCreds();
  const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

  if (cmd === "get") {
    if (!sub) die("usage: get <path> [--query k=v ...]");
    out(await api(creds, "GET", sub.startsWith("/") ? sub : `/${sub}`, { query: flags.query }));
    return;
  }

  if (cmd === "feedback") {
    if (sub === "list") {
      const { sessions } = await api(creds, "GET", "/api/v1/feedback/sessions", {
        query: { project: flags.project, status: flags.status, preview: flags.preview },
      });
      if (!sessions.length) {
        process.stdout.write("no sessions\n");
        return;
      }
      for (const s of sessions) {
        const rec = s.hasRecording ? "REC" : "   ";
        process.stdout.write(
          `${rec}  ${String(s.status).padEnd(9)} ${s.feedbackSessionId}  ${s.project}  ${s.reviewerRole ?? "?"}  ${s.createdAt}\n`,
        );
      }
      return;
    }

    if (sub === "projects") {
      const { projects } = await api(creds, "GET", "/api/v1/feedback/projects");
      if (!projects.length) {
        process.stdout.write("no projects\n");
        return;
      }
      for (const p of projects) {
        process.stdout.write(`${p.slug}${p.label ? `  (${p.label})` : ""}\n`);
      }
      return;
    }

    if (sub === "mint-token") {
      if (!flags.project) die("usage: feedback mint-token --project <slug> [--label <name>] [--days <n>]");
      const body = { project: flags.project };
      if (flags.label) body.label = flags.label;
      if (flags.days) body.days = Number(flags.days);
      const { token, project, expiresAt } = await api(creds, "POST", "/api/v1/feedback/tokens", {
        body,
      });
      // Metadata to stderr; bare token to stdout so `TOKEN=$(... mint-token)` works.
      process.stderr.write(`project: ${project}\nexpires: ${expiresAt ?? "never"}\n`);
      process.stdout.write(`${token}\n`);
      return;
    }

    if (sub === "get") {
      const id = rest[0];
      if (!id) die("usage: feedback get <sessionId>");
      out(await api(creds, "GET", `/api/v1/feedback/sessions/${encodeURIComponent(id)}`));
      return;
    }

    if (sub === "fetch") {
      const id = rest[0];
      if (!id) die("usage: feedback fetch <sessionId> [--out <dir>]");
      const enc = encodeURIComponent(id);
      const { session, annotations } = await api(creds, "GET", `/api/v1/feedback/sessions/${enc}`);
      const outDir = flags.out ?? join(process.cwd(), "feedback", id);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "session.json"), JSON.stringify(session, null, 2));
      writeFileSync(join(outDir, "annotations.json"), JSON.stringify(annotations, null, 2));
      process.stdout.write(`wrote ${annotations.length} annotation(s) -> ${outDir}/\n`);

      if (session.recordingConfirmedAt) {
        const { url } = await api(creds, "GET", `/api/v1/feedback/sessions/${enc}/recording`);
        const dl = await fetch(url);
        if (!dl.ok) die(`recording download failed: ${dl.status}`);
        const buf = Buffer.from(await dl.arrayBuffer());
        const zipPath = join(outDir, "recording.zip");
        writeFileSync(zipPath, buf);
        process.stdout.write(`wrote recording (${buf.length} bytes) -> ${zipPath}\n`);
        process.stdout.write(`\nAnalyze it: run /inc-review-feedback on ${zipPath}\n`);
      } else {
        process.stdout.write("(no recording on this session)\n");
      }
      return;
    }

    die("usage: feedback ( list | get <id> | fetch <id> | projects | mint-token )");
  }

  if (cmd === "pad") {
    await padCommand(creds, sub, rest, flags, out);
    return;
  }

  die("usage: inc-build ( get <path> | feedback <list|get|fetch> | pad <subcommand> )");
}

main().catch((err) => die(err?.message ?? String(err)));
