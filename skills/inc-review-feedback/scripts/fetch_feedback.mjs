#!/usr/bin/env node
// Resolve a preview-feedback submission from the incubator collector and download its
// riffrec bundle, so the review-feedback skill can analyze feedback that was *submitted*
// (via the preview annotation tool) rather than only a zip that is already on disk.
//
// It never talks to the collector directly — it shells out to the sibling `inc-build.mjs`
// so org auth stays single-sourced there.
//
//   node fetch_feedback.mjs <query> [--out <dir>] [--include-open] [--repo-dir <dir>]
//   node fetch_feedback.mjs --branch            # match sessions to the current git branch
//   node fetch_feedback.mjs --list              # print recent submissions and stop
//
// <query> is one of:
//   - a link            https://…/f/<id>  (any URL; the id is the last path segment)
//   - a session id       88240c83-dfd7-…  (or a non-uuid id like qa-e2e-9a3b922b)
//   - a reviewer / text  "nick"           (substring-matched against reviewerName, then project/pageUrl)
//
// Output contract (stdout), for the skill to parse:
//   RESOLVED_SESSION=<id>
//   RESOLVED_ZIP=<path>           # present when the session has a recording
//   RESOLVED_ANNOTATIONS=<path>   # present when there is no recording (annotation-only feedback)
//   RESOLVED_DIR=<dir>
// Exit codes: 0 resolved · 1 no match · 2 ambiguous (candidates printed) · 3 usage/error.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ -> inc-review-feedback/ -> skills/ -> <plugin root>/scripts/inc-build.mjs
const INC_BUILD = join(__dirname, "..", "..", "..", "scripts", "inc-build.mjs");

function die(msg, code = 3) {
  process.stderr.write(`fetch_feedback: ${msg}\n`);
  process.exit(code);
}

function incBuild(args, { capture = false } = {}) {
  try {
    const out = execFileSync(process.execPath, [INC_BUILD, ...args], {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    return out;
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    die(`inc-build ${args.join(" ")} failed: ${err.message}`, 3);
  }
}

function parseArgs(argv) {
  const flags = { includeOpen: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--branch") flags.branch = true;
    else if (a === "--list") flags.list = true;
    else if (a === "--include-open") flags.includeOpen = true;
    else if (a === "--out") flags.out = argv[++i];
    else if (a === "--repo-dir") flags.repoDir = argv[++i];
    else if (a.startsWith("--")) die(`unknown flag: ${a}`);
    else positional.push(a);
  }
  flags.query = positional.join(" ").trim();
  return flags;
}

function loadSessions() {
  const raw = incBuild(["get", "/api/v1/feedback/sessions"], { capture: true });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die("could not parse the sessions list from inc-build (auth expired?)", 3);
  }
  const sessions = parsed.sessions ?? parsed;
  if (!Array.isArray(sessions)) die("unexpected sessions payload shape", 3);
  return sessions;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function looksLikeId(str, sessions) {
  if (UUID_RE.test(str)) return str.match(UUID_RE)[0];
  if (sessions.some((s) => s.feedbackSessionId === str)) return str;
  return null;
}

function idFromUrl(str) {
  if (!/^https?:\/\//i.test(str)) return null;
  try {
    const u = new URL(str);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) return UUID_RE.test(seg) ? seg.match(UUID_RE)[0] : seg;
  } catch {
    /* not a url */
  }
  return null;
}

function ts(s) {
  return Date.parse(s.submittedAt || s.createdAt || 0) || 0;
}

// Best first: submitted, then has-recording, then newest.
function rank(list) {
  return [...list].sort((a, b) => {
    const sub = (b.status === "submitted") - (a.status === "submitted");
    if (sub) return sub;
    const rec = (b.hasRecording ? 1 : 0) - (a.hasRecording ? 1 : 0);
    if (rec) return rec;
    return ts(b) - ts(a);
  });
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function gh(args, cwd) {
  try {
    return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function matchByBranch(sessions, repoDir) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
  const prNum = gh(["pr", "view", "--json", "number", "-q", ".number"], repoDir);
  const top = git(["rev-parse", "--show-toplevel"], repoDir);
  const repoName = (gh(["repo", "view", "--json", "name", "-q", ".name"], repoDir) || (top ? top.split("/").pop() : "") || "").toLowerCase();
  const ctx = { branch, prNum, repoName };

  const hit = (s) => {
    const url = (s.pageUrl || "").toLowerCase();
    const key = (s.previewKey || "").toLowerCase();
    const proj = (s.project || "").toLowerCase();
    if (prNum && (url.includes(`pr-${prNum}-`) || url.includes(`pr-${prNum}.`) || key.includes(`pr-${prNum}`))) return true;
    if (repoName && repoName.length > 2 && (proj.startsWith(repoName) || url.includes(repoName))) return true;
    if (branch && branch.length > 2 && (key.includes(branch.toLowerCase()) || url.includes(branch.toLowerCase()))) return true;
    return false;
  };
  return { matches: sessions.filter(hit), ctx };
}

function matchByText(sessions, q) {
  const needle = q.toLowerCase();
  const byName = sessions.filter((s) => (s.reviewerName || "").toLowerCase().includes(needle));
  if (byName.length) return byName;
  return sessions.filter(
    (s) => (s.project || "").toLowerCase().includes(needle) || (s.pageUrl || "").toLowerCase().includes(needle),
  );
}

function printTable(list) {
  for (const s of rank(list)) {
    const rec = s.hasRecording ? "REC" : "   ";
    const who = s.reviewerName || s.reviewerRole || "?";
    process.stderr.write(
      `  ${rec}  ${String(s.status).padEnd(9)} ${s.feedbackSessionId}  ${s.project}  ${who}  ${ts(s) ? new Date(ts(s)).toISOString() : "?"}\n`,
    );
  }
}

function fetchAndReport(id, outFlag) {
  const outDir = outFlag || join(tmpdir(), "review-feedback", id);
  mkdirSync(outDir, { recursive: true });
  incBuild(["feedback", "fetch", id, "--out", outDir]);
  const zip = join(outDir, "recording.zip");
  const ann = join(outDir, "annotations.json");
  process.stdout.write(`\nRESOLVED_SESSION=${id}\n`);
  process.stdout.write(`RESOLVED_DIR=${outDir}\n`);
  if (existsSync(zip)) {
    process.stdout.write(`RESOLVED_ZIP=${zip}\n`);
  } else if (existsSync(ann)) {
    process.stdout.write(`RESOLVED_ANNOTATIONS=${ann}\n`);
    process.stdout.write("NOTE=annotation-only feedback (no recording) — summarize the annotations directly; the analyzer needs a recording.\n");
  }
  process.exit(0);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const sessions = loadSessions();
  const submittedFirst = flags.includeOpen ? sessions : sessions.filter((s) => s.status === "submitted" || s.hasRecording);

  if (flags.list) {
    process.stderr.write("Recent feedback submissions (best first):\n");
    printTable(submittedFirst.length ? submittedFirst : sessions);
    process.exit(0);
  }

  // 1) Explicit link or session id — fetch straight away.
  const fromUrl = flags.query && idFromUrl(flags.query);
  const asId = flags.query && !fromUrl && looksLikeId(flags.query, sessions);
  const directId = fromUrl || asId;
  if (directId) return fetchAndReport(directId, flags.out);

  // 2) Current branch.
  if (flags.branch || !flags.query) {
    const { matches, ctx } = matchByBranch(sessions, flags.repoDir || process.cwd());
    const pool = matches.filter((s) => flags.includeOpen || s.status === "submitted" || s.hasRecording);
    const ranked = rank(pool.length ? pool : matches);
    if (!ranked.length) {
      process.stderr.write(
        `No submissions matched this branch (branch=${ctx.branch ?? "?"}, pr=${ctx.prNum ?? "none"}, repo=${ctx.repoName || "?"}).\n` +
          "Pass a reviewer name (e.g. \"nick\"), a link, or a session id — or run with --list to browse.\n",
      );
      process.exit(1);
    }
    if (ranked.length > 1) {
      process.stderr.write(`Multiple submissions match this branch (pr=${ctx.prNum ?? "none"}). Pick one and re-run with its id:\n`);
      printTable(ranked);
      process.exit(2);
    }
    return fetchAndReport(ranked[0].feedbackSessionId, flags.out);
  }

  // 3) Reviewer name / free text.
  const matches = matchByText(sessions, flags.query);
  const strong = matches.filter((s) => s.status === "submitted" || s.hasRecording);
  const pool = strong.length ? strong : matches;
  const ranked = rank(pool);
  if (!ranked.length) {
    process.stderr.write(`No submission matched "${flags.query}". Run with --list to browse, or pass a link / session id.\n`);
    process.exit(1);
  }
  if (ranked.length > 1) {
    process.stderr.write(`"${flags.query}" matched ${ranked.length} submissions. Pick one and re-run with its id:\n`);
    printTable(ranked);
    process.exit(2);
  }
  return fetchAndReport(ranked[0].feedbackSessionId, flags.out);
}

main();
