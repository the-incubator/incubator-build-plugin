#!/usr/bin/env node
// Routing evals: assert that realistic user prompts trigger the expected skill.
//
// For each fixture in evals/routing.yaml this spawns a headless
// `claude -p <prompt>` with the plugin loaded via --plugin-dir, permission
// mode dontAsk (only the Skill tool and read-only commands can execute — no
// writes, no side effects), a small turn cap, and parses the stream-json
// output for the first Skill tool_use. The invoked skill is compared against
// `expect` after normalization. A skill call anywhere within the turn cap
// counts: models often poke the (empty) cwd read-only before routing, and
// hitting the turn cap without a skill call is itself the routing failure
// we're measuring.
//
// Environment isolation: when ANTHROPIC_API_KEY is set (CI, or exported
// locally), runs use --bare so ONLY this plugin is loaded — that's the
// authoritative configuration. Without it, runs fall back to your normal
// claude auth AND your personal plugins/skills, which can legitimately steal
// routing (e.g. another debugging skill wins) — treat unkeyed local results
// as indicative, not authoritative.
//
// These evals cost real tokens and are non-deterministic, so they gate the
// beta→main release promotion (see .github/workflows/evals.yml and
// RELEASING.md), not every feature PR.
//
// Usage:
//   node evals/run-routing.mjs [--filter <substr>] [--model <model>]
//                              [--concurrency <n>] [--timeout <secs>]
//                              [--max-turns <n>] [--attempts <n>] [--keep-logs]
//
// Defaults: model=sonnet, concurrency=4, timeout=180s per case, max-turns=4,
// attempts=2. Routing is sampled from a model, so a single run can flake
// (the model just does the work inline instead of invoking the skill);
// a case passes if ANY attempt routes to an expected skill. A case that
// fails every attempt is a real routing regression.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_PATH = join(REPO_ROOT, "evals", "routing.yaml");

// ── CLI args ────────────────────────────────────────────────────────────────

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FILTER = argValue("--filter", null);
const MODEL = argValue("--model", "sonnet");
const CONCURRENCY = Math.max(1, Number.parseInt(argValue("--concurrency", "4"), 10) || 4);
const TIMEOUT_MS = (Number.parseInt(argValue("--timeout", "180"), 10) || 180) * 1000;
const MAX_TURNS = argValue("--max-turns", "4");
const ATTEMPTS = Math.max(1, Number.parseInt(argValue("--attempts", "2"), 10) || 2);
const BARE = Boolean(process.env.ANTHROPIC_API_KEY);

// Headless -p sessions lack the interactive harness's skill-use nudging, so
// the model often just does the work inline with Bash — which would measure
// skill-use *propensity* (a headless artifact), not skill *selection* (what
// these evals guard: the trigger phrases in each skill's description). The
// nudge forces a selection so the fixtures always measure which skill wins.
const ROUTING_NUDGE =
  "When the user's request matches one of the available skills, you MUST invoke that skill " +
  "with the Skill tool instead of handling the request directly. Pick the single best-matching " +
  "skill and invoke it as your first action.";
// --keep-logs writes each case's raw stream to evals/.artifacts/<case>.jsonl
// for debugging routing failures (gitignored; also handy as a CI artifact).
const KEEP_LOGS = process.argv.includes("--keep-logs");
const ARTIFACTS_DIR = join(REPO_ROOT, "evals", ".artifacts");

// ── Skill-name normalization ────────────────────────────────────────────────
// Skill names in the wild vary: frontmatter uses "inc:merge-pr-5", the Skill
// tool may report it plugin-qualified as "incubator-build:inc:merge-pr-5",
// fixtures use folder-style "inc-merge-pr". Normalize all three to compare:
// lowercase, strip plugin prefix, ":" → "-", strip trailing "-<digits>"
// version suffix (so fixtures survive skill version-suffix renames).

function normalizeSkill(raw) {
  if (!raw) return null;
  let s = String(raw).toLowerCase().trim();
  if (s.startsWith("incubator-build:")) s = s.slice("incubator-build:".length);
  s = s.replaceAll(":", "-");
  s = s.replace(/-\d+$/, "");
  return s;
}

// ── Stream parsing ──────────────────────────────────────────────────────────
// stream-json emits newline-delimited JSON. A Skill invocation appears as a
// tool_use — either as a content block inside an assistant message event, or
// as a top-level tool_use event depending on CLI version. The Skill tool's
// input field is `skill` (see hooks/_util.mjs sanitize()), with `name` kept
// as a defensive fallback.

function skillFromEvent(evt) {
  const blocks = [];
  if (evt?.type === "assistant" && Array.isArray(evt?.message?.content)) {
    blocks.push(...evt.message.content);
  }
  if (evt?.type === "tool_use") blocks.push(evt);
  for (const b of blocks) {
    const toolName = b?.name ?? b?.tool;
    if (b?.type === "tool_use" && toolName === "Skill") {
      return b?.input?.skill ?? b?.input?.name ?? null;
    }
  }
  return null;
}

// ── Scratch workspace ───────────────────────────────────────────────────────
// Routing only fires when the prompt is plausible in context: "commit these
// changes" in an empty directory has nothing to route about, and the model
// (correctly) answers in prose instead of invoking a skill. Every case gets
// the same minimal-but-real workspace: a git repo, a small TypeScript project
// whose build.ts matches the debug fixture's stack trace, and an uncommitted
// change. Isolated from this repo, so CLAUDE.md / project skills can't skew
// routing.

function makeScratchWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "routing-eval-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "scratch-app", version: "1.0.0", scripts: { build: "tsc" } }, null, 2),
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src", "build.ts"),
    [
      "interface Step { name: string; deps?: string[] }",
      "",
      "export class BuildStep {",
      "  constructor(private steps?: Step[]) {}",
      "  run() {",
      "    return this.steps.map((s) => s.name); // build.ts:42 in the real app",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "README.md"), "# scratch-app\n\nInternal build tooling.\n");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "eval",
        GIT_AUTHOR_EMAIL: "eval@example.com",
        GIT_COMMITTER_NAME: "eval",
        GIT_COMMITTER_EMAIL: "eval@example.com",
      },
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "initial commit");
  git("checkout", "-q", "-b", "feat/reports-export");
  // Leave an uncommitted change so commit/review/PR prompts have something real.
  appendFileSync(join(dir, "src", "build.ts"), "export const BUILD_VERSION = 2;\n");
  return dir;
}

// ── Single case ─────────────────────────────────────────────────────────────

function runCase(fixture) {
  return new Promise((resolvePromise) => {
    const cwd = makeScratchWorkspace();
    const args = [
      "-p",
      fixture.prompt,
      "--plugin-dir",
      REPO_ROOT,
      "--model",
      MODEL,
      "--max-turns",
      MAX_TURNS,
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Skill",
      "--append-system-prompt",
      ROUTING_NUDGE,
      "--output-format",
      "stream-json",
      "--verbose",
      ...(BARE ? ["--bare"] : []),
    ];

    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        finish({ got: null, error: `timeout after ${TIMEOUT_MS / 1000}s` });
      }
    }, TIMEOUT_MS);

    function finish(outcome) {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      const expected = Array.isArray(fixture.expect) ? fixture.expect : [fixture.expect];
      const gotNorm = normalizeSkill(outcome.got);
      const pass = gotNorm !== null && expected.map(normalizeSkill).includes(gotNorm);
      resolvePromise({
        name: fixture.name,
        expected,
        got: outcome.got ?? "(no skill invoked)",
        pass,
        error: outcome.error ?? null,
      });
    }

    // Parse the stream incrementally and kill the run at the first Skill
    // invocation — the routing decision is made; further turns only cost tokens.
    let sawMaxTurns = false;
    function scanLines(chunk) {
      if (KEEP_LOGS) {
        try {
          appendFileSync(join(ARTIFACTS_DIR, `${fixture.name}.jsonl`), chunk);
        } catch {}
      }
      stdout += chunk;
      let nl;
      while ((nl = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt?.type === "result" && evt?.subtype === "error_max_turns") sawMaxTurns = true;
        const skill = skillFromEvent(evt);
        if (skill && !settled) {
          settled = true;
          child.kill("SIGKILL");
          finish({ got: skill });
          return;
        }
      }
    }

    child.stdout.on("data", scanLines);
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      finish({ got: null, error: `spawn failed: ${err.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      // Stream ended with no Skill invocation. A non-zero exit that isn't the
      // expected error_max_turns points at a harness problem, so surface stderr.
      if (code !== 0 && !sawMaxTurns && stderr.trim()) {
        finish({ got: null, error: `claude exited ${code}: ${stderr.slice(0, 300)}` });
      } else {
        finish({ got: null });
      }
    });
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

const fixtures = yaml.load(readFileSync(FIXTURES_PATH, "utf8")).cases ?? [];
const selected = FILTER ? fixtures.filter((f) => f.name.includes(FILTER)) : fixtures;

if (selected.length === 0) {
  console.error(`no fixtures match --filter "${FILTER}"`);
  process.exit(1);
}

console.log(
  `routing evals: ${selected.length}/${fixtures.length} case(s), model=${MODEL}, concurrency=${CONCURRENCY}, max-turns=${MAX_TURNS}, mode=${BARE ? "bare (authoritative)" : "user env (indicative — your other plugins/skills also load and can steal routing)"}\n`,
);

if (KEEP_LOGS) {
  rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < selected.length) {
    const fixture = selected[cursor++];
    let r;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      r = await runCase(fixture);
      r.attempt = attempt;
      if (r.pass) break;
    }
    const mark = r.pass ? "✓" : "✗";
    const retryNote = r.pass && r.attempt > 1 ? `  (attempt ${r.attempt})` : "";
    const detail = r.pass ? retryNote : `  (expected ${r.expected.join(" | ")}, got ${r.got}${r.error ? `; ${r.error}` : ""}; ${ATTEMPTS} attempt(s))`;
    console.log(`  ${mark} ${r.name}${detail}`);
    results.push(r);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error(`\nFAILED (${failed.length}):`);
  for (const r of failed) {
    console.error(`  ✗ ${r.name}: expected ${r.expected.join(" | ")}, got ${r.got}${r.error ? ` [${r.error}]` : ""}`);
  }
  process.exit(1);
}
