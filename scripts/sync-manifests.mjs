#!/usr/bin/env node
// Root plugin.json owns shared metadata. Host manifests are generated thin adapters.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(readFileSync(resolve(root, "plugin.json"), "utf8"));
const { name, version, description, author, repository } = metadata;
const displayName = "Incubator Build";
const marketplaceName = "incubator";
const ui = {
  displayName,
  shortDescription: "Curated skills for planning, code review, debugging, and shipping PRs.",
  longDescription: description,
  developerName: author.name,
  websiteURL: repository,
};
const entry = { name, source: "./", description };
const marketplace = {
  name: marketplaceName, owner: author,
  metadata: { description: "Incubator Build skills for coding agents" },
  plugins: [entry],
};
const manifests = {
  ".claude-plugin/plugin.json": metadata,
  ".claude-plugin/marketplace.json": marketplace,
  ".codex-plugin/plugin.json": {
    ...metadata,
    skills: "./skills/",
    interface: {
      ...ui, category: "Development", capabilities: ["Interactive", "Read", "Write"],
      defaultPrompt: ["Use Incubator Build to plan this change", "Review this PR with Incubator Build", "Ship this PR with Incubator Build"],
    },
  },
  ".agents/plugins/marketplace.json": {
    name: marketplaceName,
    interface: { displayName },
    plugins: [{
      name, source: { source: "local", path: "./" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Coding",
    }],
  },
  ".cursor-plugin/plugin.json": { ...metadata, displayName },
  ".cursor-plugin/marketplace.json": marketplace,
  ".kimi-plugin/plugin.json": {
    name, version, description, keywords: metadata.keywords, author: author.name,
    homepage: repository, skills: "./skills/", interface: ui,
  },
  ".kimi-plugin/marketplace.json": {
    version: "2", plugins: [{ id: name, displayName, source: repository }],
  },
  ".grok-plugin/plugin.json": { ...metadata, skills: "./skills/" },
  ".grok-plugin/marketplace.json": {
    name: marketplaceName, owner: author,
    plugins: [{ name, description, source: { source: "url", url: `${repository}.git` } }],
  },
  ".devin-plugin/plugin.json": metadata,
  ".omp-plugin/marketplace.json": {
    ...marketplace, plugins: [{ ...entry, version }],
  },
};

const check = process.argv.includes("--check");
let stale = false;
for (const [path, value] of Object.entries(manifests)) {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  const file = resolve(root, path);
  if (check) {
    let actual;
    try { actual = readFileSync(file, "utf8"); } catch { /* missing is stale */ }
    if (actual !== expected) {
      console.error(`Stale manifest: ${path}. Run npm run manifests:sync.`);
      stale = true;
    }
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, expected);
  }
}
const packageFile = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
if (check) {
  if (pkg.version !== version) {
    console.error("package.json version differs from plugin.json; run npm run manifests:sync.");
    stale = true;
  }
} else if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
}
if (stale) process.exitCode = 1;
