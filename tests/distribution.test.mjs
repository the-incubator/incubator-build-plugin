import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import piExtension from "../.pi/extensions/incubator-build.js";
import openCodePlugin from "../.opencode/plugins/incubator-build.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const skills = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const path = `skills/${entry.name}/SKILL.md`;
    const body = read(path);
    return { path, body, ...yaml.load(body.match(/^---\n([\s\S]*?)\n---/)[1]) };
  });
function sandbox(t) {
  const base = join(root, ".context");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "distribution test "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("host metadata is generated from one version and root manifest stays schema-less", () => {
  execFileSync(process.execPath, [join(root, "scripts/sync-manifests.mjs"), "--check"]);
  assert.equal(json("plugin.json").$schema, undefined);
  assert.equal(json("package-lock.json").version, json("plugin.json").version);
  assert.equal(json("package-lock.json").packages[""].version, json("plugin.json").version);
  for (const host of ["codex", "kimi", "grok"]) {
    assert.equal(realpathSync(resolve(root, json(`.${host}-plugin/plugin.json`).skills)), realpathSync(join(root, "skills")));
  }
  const app = json(".agents/plugins/marketplace.json").plugins[0];
  assert.equal(app.source.source, "local");
  assert.equal(resolve(root, app.source.path), root);
  assert.equal(json(".omp-plugin/marketplace.json").plugins[0].version, json("plugin.json").version);
  assert.equal(json(".devin-plugin/plugin.json").skills, undefined, "Devin discovers root skills by convention");
  assert.ok(!lstatSync(join(root, "skills")).isSymbolicLink());
});

test("Pi registers exactly the installed root corpus for startup and reload", async () => {
  const handlers = new Map();
  piExtension({ on(event, handler) { assert.ok(!handlers.has(event)); handlers.set(event, handler); } });
  assert.deepEqual([...handlers.keys()], ["resources_discover"]);
  for (const reason of ["startup", "reload"]) {
    const result = await handlers.get("resources_discover")({ reason, cwd: "/unrelated/project" });
    assert.deepEqual(result, { skillPaths: [join(root, "skills/")] });
  }
  const pkg = json("package.json");
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  for (const extension of pkg.pi.extensions) assert.ok(existsSync(resolve(root, extension)));
});

test("OpenCode registers all visible commands, preserves configuration, and is idempotent", async () => {
  const plugin = await openCodePlugin();
  const custom = { template: "My guide command" };
  const config = { skills: { paths: ["/my/skills"], urls: ["https://example.com/skills"] }, command: { "inc:guide": custom, custom: { template: "Keep me" } } };
  await plugin.config(config);
  await plugin.config(config);
  assert.deepEqual(config.skills.paths, ["/my/skills", join(root, "skills/")]);
  assert.deepEqual(config.skills.urls, ["https://example.com/skills"]);
  assert.equal(config.command["inc:guide"], custom);
  assert.equal(config.command.custom.template, "Keep me");
  for (const skill of skills.filter((s) => s["user-invocable"] !== false && s.name !== "inc:guide")) {
    assert.ok(config.command[skill.name].template.includes(JSON.stringify(join(root, skill.path))));
    assert.ok(config.command[skill.name].template.endsWith("$ARGUMENTS"));
    assert.equal(config.command[skill.name].description, skill.description);
  }
  const empty = {};
  await plugin.config(empty);
  assert.ok(empty.command["inc:review-and-pr"]);
});

test("installed adapters resolve package resources independently of cwd and spaces", async (t) => {
  const dir = sandbox(t);
  const unpacked = join(dir, "installed package");
  const files = [".pi/extensions/incubator-build.js", ".opencode/plugins/incubator-build.js"];
  // A relocated package fixture, not just source-tree path assertions.
  for (const file of files) {
    mkdirSync(dirname(join(unpacked, file)), { recursive: true });
    writeFileSync(join(unpacked, file), read(file));
  }
  writeFileSync(join(unpacked, "package.json"), '{"type":"module"}\n');
  symlinkSync(join(root, "skills"), join(unpacked, "skills"), "dir");
  const { default: relocatedPi } = await import(pathToFileURL(join(unpacked, files[0])).href);
  let discover;
  relocatedPi({ on(_event, callback) { discover = callback; } });
  assert.deepEqual((await discover({ cwd: dir })).skillPaths, [join(unpacked, "skills/")]);
  const { default: relocatedOpenCode } = await import(pathToFileURL(join(unpacked, files[1])).href);
  const config = {};
  await (await relocatedOpenCode()).config(config);
  assert.deepEqual(config.skills.paths, [join(unpacked, "skills/")]);
  assert.ok(config.command["inc:guide"].template.includes(join(unpacked, "skills", "inc-guide", "SKILL.md")));
});

test("skill links, composition map, and referenced persona assets exist at install root", () => {
  const paths = [
    ...skills.map((s) => s.path), "skills/inc-guide/references/host-compatibility.md",
    "README.md", "notes/multi-host-distribution.md", ".opencode/INSTALL.md", ".cline/INSTALL.md", ".agy/INSTALL.md",
  ];
  for (const path of paths) {
    const body = read(path);
    for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split(/[?#]/)[0];
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
      assert.ok(existsSync(resolve(root, dirname(path), target)), `${path}: ${target}`);
    }
    for (const match of body.matchAll(/^@\.\/(\S+)$/gm)) {
      assert.ok(existsSync(resolve(root, dirname(path), match[1])), `${path}: ${match[1]}`);
    }
  }
  const catalog = read("skills/inc-review-deep/references/persona-catalog.md");
  for (const match of catalog.matchAll(/`(review|research):(inc-[a-z-]+)`/g)) {
    assert.ok(existsSync(join(root, "agents", match[1], `${match[2]}.agent.md`)), match[0]);
  }
  const composition = read("skills/inc-guide/references/host-compatibility.md");
  for (const match of composition.matchAll(/\| `([^`]+)` \| \[skills\/[^\]]+\]\(([^)]+)\)/g)) {
    const child = readFileSync(resolve(root, "skills/inc-guide/references", match[2]), "utf8");
    const fields = yaml.load(child.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert.equal(fields.name, match[1]);
  }
});

test("closeout composition retains fail-closed gates and explicit inline handoffs", () => {
  for (const name of ["inc-review-and-pr", "inc-ship-it", "inc-commit-push-pr", "inc-resolve-pr-feedback", "inc-merge-pr"]) {
    const body = read(`skills/${name}/SKILL.md`);
    assert.ok(body.includes("host-compatibility.md"), name);
    assert.doesNotMatch(body, /via the `?Skill`? tool/, name);
  }
  const review = read("skills/inc-review-and-pr/SKILL.md");
  assert.ok(review.includes("ASK_USER=ERROR"));
  assert.ok(review.includes('**`ASK_USER` > 0 → STOP.**'));
  assert.ok(review.includes("Do **not** run `inc:merge-pr-5`"));
  assert.ok(review.includes("../inc-commit-push-pr/SKILL.md"));
  assert.ok(read("skills/inc-commit-push-pr/SKILL.md").includes("with the explicit `--auto` argument"));
});

test("Cursor/Cline installer is idempotent, project-scoped, and preserves conflicts", (t) => {
  const dir = sandbox(t);
  const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/install-skills.mjs"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: join(dir, "home") } });
  for (const host of ["cursor", "cline"]) {
    assert.equal(run(host, "--project").status, 0);
    assert.equal(run(host, "--project").status, 0);
    assert.equal(realpathSync(join(dir, `.${host}/skills/inc-guide/SKILL.md`)), join(root, "skills/inc-guide/SKILL.md"));
  }
  assert.equal(existsSync(join(dir, "home")), false, "project install must not touch user config");
  assert.equal(run("cursor", "--global").status, 0);
  assert.equal(realpathSync(join(dir, "home/.cursor/skills/inc-guide")), join(root, "skills/inc-guide"));
  const target = join(dir, ".cursor/skills/inc-guide");
  rmSync(target);
  mkdirSync(target);
  writeFileSync(join(target, "user.txt"), "keep");
  const conflict = run("cursor", "--project");
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Conflict \(left unchanged\)/);
  assert.equal(readFileSync(join(target, "user.txt"), "utf8"), "keep");
  rmSync(target, { recursive: true });
  symlinkSync(join(dir, "missing target"), target);
  assert.equal(run("cursor", "--project").status, 1);
  assert.ok(lstatSync(target).isSymbolicLink());
  rmSync(target);
  const foreign = join(dir, "foreign skill");
  mkdirSync(foreign);
  symlinkSync(foreign, target);
  assert.equal(run("cursor", "--project").status, 1);
  assert.equal(realpathSync(target), foreign);
  assert.equal(run("unknown", "--project").status, 1);
  assert.equal(run("cursor", "--project", "--global").status, 1);
});

test("npm package includes the full corpus, personas, and every adapter without workspace state", () => {
  const manifest = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }))[0];
  const files = new Set(manifest.files.map((f) => f.path));
  for (const entry of [...skills.map((s) => s.path), "agents/inc-pr-comment-resolver.agent.md", "skills/inc-guide/references/host-compatibility.md", "scripts/branch-freshness", "scripts/gh-thread-cache", "plugin.json", json("package.json").main, ...json("package.json").pi.extensions.map((p) => p.replace(/^\.\//, ""))]) {
    assert.ok(files.has(entry), `Missing from package: ${entry}`);
  }
  for (const host of ["claude", "codex", "cursor", "grok", "kimi", "devin"]) assert.ok(files.has(`.${host}-plugin/plugin.json`));
  assert.ok(files.has(".agents/plugins/marketplace.json"));
  assert.ok(files.has(".omp-plugin/marketplace.json"));
  assert.ok(json("package.json").dependencies["js-yaml"], "OpenCode runtime dependency must survive production install");
  for (const file of files) assert.doesNotMatch(file, /^(?:\.context|node_modules|\.git|\.claude\/|deploy\.md)/);
});

test("Cline manual-only policy is explicit", (t) => {
  const dir = sandbox(t);
  // Use a tiny fixture so this tests policy even when the real corpus has no manual-only skill.
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(join(dir, "scripts/install-skills.mjs"), read("scripts/install-skills.mjs"));
  mkdirSync(join(dir, "skills/manual"), { recursive: true });
  writeFileSync(join(dir, "skills/manual/SKILL.md"), "---\nname: manual\ndescription: Manual skill\ndisable-model-invocation: true\n---\nBody\n");
  const run = (...args) => spawnSync(process.execPath, [join(dir, "scripts/install-skills.mjs"), "cline", "--project", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(run().status, 0);
  assert.equal(existsSync(join(dir, ".cline/skills/manual")), false);
  const included = run("--include-manual");
  assert.equal(included.status, 0);
  assert.match(included.stderr, /may auto-activate/);
  assert.ok(lstatSync(join(dir, ".cline/skills/manual")).isSymbolicLink());
});
