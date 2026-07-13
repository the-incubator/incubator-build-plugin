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
//
// Auth: sends `Authorization: Bearer <apiKey>` from credentials.json. Errors are
// surfaced (non-zero exit) rather than swallowed, unlike the telemetry hooks.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDS_PATH = join(homedir(), ".claude", "incubator", "credentials.json");

const die = (m) => {
  process.stderr.write(`inc-build: ${m}\n`);
  process.exit(1);
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

async function api(creds, method, path, { query, body } = {}) {
  const base = creds.endpoint.replace(/\/$/, "");
  const qs = query
    ? "?" +
      Object.entries(query)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  const res = await fetch(`${base}${path}${qs}`, {
    method,
    headers: {
      authorization: `Bearer ${creds.apiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    die(`${method} ${path} failed (${res.status}): ${json.reason ?? "unknown"}`);
  }
  return json;
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query") {
      const [k, ...v] = (argv[++i] ?? "").split("=");
      (flags.query ??= {})[k] = v.join("=");
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[++i];
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
`;

async function main() {
  const [cmd, sub, ...tail] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const { flags, rest } = parseFlags(tail);
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
        process.stdout.write(`\nAnalyze it: run /inc:riffrec-feedback on ${zipPath}\n`);
      } else {
        process.stdout.write("(no recording on this session)\n");
      }
      return;
    }

    die("usage: feedback ( list | get <id> | fetch <id> | projects | mint-token )");
  }

  die("usage: inc-build ( get <path> | feedback <list|get|fetch> )");
}

main().catch((err) => die(err?.message ?? String(err)));
