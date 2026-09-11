// Optional integration check: real Codex CLI, isolated HOME/CODEX_HOME, local
// deterministic Responses server. No model credentials or live user config.
// Usage: TMPDIR=<scratch directory> node notes/codex-hooks-upgrade/smoke.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "codex-hooks-live-"));
const home = join(scratch, "home");
const codexHome = join(scratch, "codex home with spaces");
const project = join(scratch, "project");
const source = join(scratch, "plugin source");
for (const path of [home, codexHome, project, source]) mkdirSync(path, { recursive: true });
for (const path of ["hooks", ".claude-plugin", ".codex-plugin"]) cpSync(join(root, path), join(source, path), { recursive: true });
cpSync(join(root, "skills/inc-commit-push-pr"), join(source, "skills/inc-commit-push-pr"), { recursive: true });
const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, INCUBATOR_TELEMETRY_DISABLED: "1", INCUBATOR_PLUGIN_UPDATE_DISABLED: "1" };
for (const key of ["CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_DATA", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[key];
function cli(args) {
  const result = spawnSync("codex", args, { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}
const version = cli(["--version"]).trim();
cli(["plugin", "marketplace", "add", source]);
const installed = JSON.parse(cli(["plugin", "add", "incubator-build@incubator", "--json"]));
function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
const hooksPath = join(installed.installedPath, "hooks/hooks.json");
const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
const eventsPath = join(scratch, "hook-events.jsonl");
const observer = join(scratch, "observer.mjs");
writeFileSync(observer, `import {appendFileSync} from "node:fs";
let input=""; for await (const part of process.stdin) input+=part;
appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({event:process.argv[2],cwd:process.cwd(),claudeRoot:process.env.CLAUDE_PLUGIN_ROOT,pluginRoot:process.env.PLUGIN_ROOT,input:JSON.parse(input)})+"\\n");`);
for (const [event, groups] of Object.entries(hooks.hooks)) {
  groups.push({ hooks: [{ type: "command", command: `node ${shellQuote(observer)} ${event}` }] });
}
writeFileSync(hooksPath, JSON.stringify(hooks));
let requests = 0;
const server = createServer(async (req, res) => {
  let input = "";
  for await (const part of req) input += part;
  JSON.parse(input); // Reject malformed requests before emitting fixture events.
  requests++;
  const item = requests === 1
    ? { type: "function_call", call_id: "smoke_call", name: "exec_command", arguments: JSON.stringify({ cmd: "printf CODEX_HOOK_SMOKE_OK", login: false }) }
    : { type: "message", id: "smoke_message", role: "assistant", content: [{ type: "output_text", text: "CODEX_HOOK_SMOKE_COMPLETE" }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `smoke_${requests}` } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id: `smoke_${requests}`, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const config = readFileSync(join(codexHome, "config.toml"), "utf8");
writeFileSync(join(codexHome, "config.toml"), `model = "smoke-model"\nmodel_provider = "smoke"\n${config}\n[model_providers.smoke]\nname = "Local hook test"\nbase_url = ${JSON.stringify(baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
const args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "--sandbox", "read-only", "-C", project, "--json", "Run the fixed local smoke command, then finish."];
let stdout = "";
let stderr = "";
let code;
try {
  const child = spawn("codex", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 45_000);
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    code = await new Promise((done, reject) => { child.on("error", reject); child.on("exit", done); });
  } finally { clearTimeout(timeout); }
} finally { server.closeAllConnections(); server.close(); }
writeFileSync(join(scratch, "stdout.jsonl"), stdout);
writeFileSync(join(scratch, "stderr.txt"), stderr);
assert.equal(code, 0, `Codex failed. Evidence: ${scratch}\n${stderr}\n${stdout}`);
assert.match(stdout, /CODEX_HOOK_SMOKE_OK/);
assert.match(stdout, /CODEX_HOOK_SMOKE_COMPLETE/);
assert.doesNotMatch(stdout + stderr, /hook exited with code|Cannot find module|Incubator Build hooks require|hook execution failed/i);
const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
  assert.ok(events.some((row) => row.event === event), `Missing ${event}: ${scratch}`);
}
for (const event of events) {
  assert.equal(event.cwd, project);
  assert.equal(event.pluginRoot, installed.installedPath);
  assert.equal(event.claudeRoot, installed.installedPath);
}
const summary = { version, pluginVersion: installed.version, provider: "local deterministic Responses fixture", exitCode: code, requests, events: events.map((row) => row.event), bothPluginRootsPresent: true, projectCwd: true, pluginPathContainsSpaces: true, toolExecuted: true, hookErrors: false };
writeFileSync(join(scratch, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ ...summary, evidenceDirectory: scratch }, null, 2));
