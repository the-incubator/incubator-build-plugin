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
//   inc-build plan blocks                            # authoritative block catalog
//   inc-build plan create --project <slug> --title <title> --plan <file> [--canvas <file>]
//   inc-build plan get <planId> [--out <dir>]
//   inc-build plan list [--project <slug>] [--status <status>]
//   inc-build plan patch <planId> --plan <file> [--canvas <file>] --expect <updatedAt>
//   inc-build plan replace <planId> --plan <file> [--canvas <file>] --expect <updatedAt>
//   inc-build plan share <planId> [--rotate] --expect <updatedAt>
//   inc-build plan open <url>
//
// Auth: sends `Authorization: Bearer <apiKey>` from credentials.json. Errors are
// surfaced (non-zero exit) rather than swallowed, unlike the telemetry hooks.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDS_PATH = join(homedir(), ".claude", "incubator", "credentials.json");

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

async function api(creds, method, path, { query, body } = {}) {
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
    });
  } catch (err) {
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

const BOOLEAN_FLAGS = new Set(["rotate", "unconsumed"]);

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
  inc-build plan blocks
  inc-build plan create --project <slug> --title <title> --plan <file> [--canvas <file>]
                        [--brief <text>] [--visibility link|org]
  inc-build plan get <planId> [--out <dir>]
  inc-build plan list [--project <slug>] [--status <status>]
  inc-build plan patch <planId> --plan <file> [--canvas <file>] --expect <updatedAt>
  inc-build plan replace <planId> --plan <file> [--canvas <file>] --expect <updatedAt>
  inc-build plan share <planId> [--rotate] --expect <updatedAt>
  inc-build plan open <url>
  inc-build plan feedback <planId>       # Phase 3 stub
  inc-build plan consume <planId>        # Phase 3 stub
`;

function readRequiredFile(path, flag) {
  if (!path) die(`usage requires ${flag}`);
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    die(`cannot read ${flag} file ${path}: ${err?.message ?? String(err)}`);
  }
}

function planFiles(flags) {
  const files = { "plan.mdx": readRequiredFile(flags.plan, "--plan") };
  if (flags.canvas) files["canvas.mdx"] = readRequiredFile(flags.canvas, "--canvas");
  return files;
}

function phase3Stub(sub) {
  die(`plan ${sub} is reserved for Phase 3; feedback and consume arrive with the reviewer feedback API`);
}

function runCommand(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandError(result) {
  return result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
}

function openPlanUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    die("plan open requires a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    die("plan open requires an http(s) URL");
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
    process.stderr.write(`opened plan in cmux browser: ${url}\n`);
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
  process.stderr.write(`opened plan in ${process.platform === "darwin" ? "Google Chrome" : launcher}: ${url}\n`);
}

async function main() {
  const [cmd, sub, ...tail] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const { flags, rest } = parseFlags(tail);
  if (cmd === "plan" && (sub === "feedback" || sub === "consume")) {
    phase3Stub(sub);
  }
  if (cmd === "plan" && sub === "open") {
    const url = rest[0];
    if (!url) die("usage: plan open <url>");
    openPlanUrl(url);
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
        process.stdout.write(`\nAnalyze it: run /inc:review-feedback on ${zipPath}\n`);
      } else {
        process.stdout.write("(no recording on this session)\n");
      }
      return;
    }

    die("usage: feedback ( list | get <id> | fetch <id> | projects | mint-token )");
  }

  if (cmd === "plan") {
    if (sub === "blocks") {
      out(await api(creds, "GET", "/api/v1/plans/blocks"));
      return;
    }

    if (sub === "create") {
      if (!flags.project || !flags.title || !flags.plan) {
        die("usage: plan create --project <slug> --title <title> --plan <file> [--canvas <file>]");
      }
      const body = {
        project: flags.project,
        title: flags.title,
        files: planFiles(flags),
      };
      if (flags.brief) body.brief = flags.brief;
      if (flags.visibility) body.visibility = flags.visibility;
      const result = await api(creds, "POST", "/api/v1/plans", { body });
      if (!result.url) die("POST /api/v1/plans returned no plan URL");
      process.stderr.write(`planId: ${result.planId}\nrevision: ${result.revision}\nupdatedAt: ${result.updatedAt}\n`);
      if (result.warnings?.length) process.stderr.write(`warnings: ${JSON.stringify(result.warnings)}\n`);
      process.stdout.write(`${result.url}\n`);
      // The API adds a writable reviewer link once share is provisioned; surface it
      // when present so the skill need not make a second `plan share` call to get one.
      if (result.reviewUrl) process.stdout.write(`reviewUrl: ${result.reviewUrl}\n`);
      return;
    }

    if (sub === "share") {
      const id = rest[0];
      if (!id || !flags.expect) {
        die("usage: plan share <planId> [--rotate] --expect <updatedAt>");
      }
      const body = { expectedUpdatedAt: flags.expect };
      if (flags.rotate) body.rotate = true;
      const result = await api(creds, "POST", `/api/v1/plans/${encodeURIComponent(id)}/share`, { body });
      if (!result.url && !result.reviewUrl) die("POST /api/v1/plans/:id/share returned no url or reviewUrl");
      process.stderr.write(`planId: ${result.planId ?? id}\nrevision: ${result.revision ?? "?"}\nupdatedAt: ${result.updatedAt ?? "?"}\n`);
      if (result.warnings?.length) process.stderr.write(`warnings: ${JSON.stringify(result.warnings)}\n`);
      if (result.url) process.stdout.write(`${result.url}\n`);
      if (result.reviewUrl) process.stdout.write(`reviewUrl: ${result.reviewUrl}\n`);
      return;
    }

    if (sub === "get") {
      const id = rest[0];
      if (!id) die("usage: plan get <planId> [--out <dir>]");
      const result = await api(creds, "GET", `/api/v1/plans/${encodeURIComponent(id)}`);
      if (!flags.out) {
        out(result);
        return;
      }
      mkdirSync(flags.out, { recursive: true });
      const files = result.files ?? {};
      for (const [name, source] of Object.entries(result.files ?? {})) {
        writeFileSync(join(flags.out, name), source);
      }
      if (!("canvas.mdx" in files)) {
        const canvasPath = join(flags.out, "canvas.mdx");
        if (existsSync(canvasPath)) unlinkSync(canvasPath);
      }
      const plan = result.plan ?? {};
      process.stderr.write(`planId: ${plan.planId ?? id}\nrevision: ${plan.revision ?? result.revision ?? "?"}\nupdatedAt: ${plan.updatedAt ?? result.updatedAt ?? "?"}\n`);
      if (result.warnings?.length) process.stderr.write(`warnings: ${JSON.stringify(result.warnings)}\n`);
      process.stdout.write(`wrote ${Object.keys(files).join(", ")} -> ${flags.out}/\n`);
      return;
    }

    if (sub === "list") {
      out(await api(creds, "GET", "/api/v1/plans", {
        query: { project: flags.project, status: flags.status },
      }));
      return;
    }

    if (sub === "patch" || sub === "replace") {
      const id = rest[0];
      if (flags.ops) {
        die("--ops is reserved for the Phase 3 PATCH API; use --plan/--canvas with the live M1 PUT endpoint");
      }
      if (!id || !flags.expect || !flags.plan) {
        die(`usage: plan ${sub} <planId> --plan <file> [--canvas <file>] --expect <updatedAt>`);
      }
      // M1 has PUT source replacement only. Keep patch as an ergonomic alias until Phase 3 adds PATCH ops.
      const result = await api(creds, "PUT", `/api/v1/plans/${encodeURIComponent(id)}/source`, {
        body: { expectedUpdatedAt: flags.expect, files: planFiles(flags) },
      });
      out(result);
      return;
    }

    die("usage: plan ( blocks | create | get | list | patch | replace | share | open | feedback | consume )");
  }

  die("usage: inc-build ( get <path> | feedback <list|get|fetch> | plan <subcommand> )");
}

main().catch((err) => die(err?.message ?? String(err)));
