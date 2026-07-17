#!/usr/bin/env node
// Channel invariant guard for the two-channel release model (see RELEASING.md).
//
// The stable channel lives on `main` (marketplace "incubator", version pinned in
// plugin.json — users only update when the version string changes). The beta
// channel lives on `beta` (marketplace "incubator-beta", NO version in
// plugin.json — every commit ships to beta users via its SHA).
//
// These files intentionally differ between the branches, so a plain
// `git merge beta` into main would rename the prod marketplace and unpin the
// version for every stable user. This guard makes that mistake fail CI (and
// scripts/release.sh, which runs it before committing a release).
//
// Usage: node scripts/check-channel.mjs [branch]
// Branch resolution order: argv, GITHUB_BASE_REF (pull_request events),
// GITHUB_REF (push events), current git branch. Branches other than
// main/beta carry no invariants and pass.

import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function currentGitBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const branch =
  process.argv[2] ||
  process.env.GITHUB_BASE_REF ||
  (process.env.GITHUB_REF || "").replace(/^refs\/heads\//, "") ||
  currentGitBranch();

if (branch !== "main" && branch !== "beta") {
  console.log(`check-channel: branch "${branch || "(unknown)"}" carries no channel invariants — OK`);
  process.exit(0);
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

const errors = [];
let marketplace, claudeManifest, codexManifest;
try {
  marketplace = readJson(".claude-plugin/marketplace.json");
} catch (e) {
  errors.push(`.claude-plugin/marketplace.json unreadable: ${e.message}`);
}
try {
  claudeManifest = readJson(".claude-plugin/plugin.json");
} catch (e) {
  errors.push(`.claude-plugin/plugin.json unreadable: ${e.message}`);
}
try {
  codexManifest = readJson(".codex-plugin/plugin.json");
} catch (e) {
  errors.push(`.codex-plugin/plugin.json unreadable: ${e.message}`);
}

if (branch === "main") {
  if (marketplace && marketplace.name !== "incubator") {
    errors.push(
      `main: marketplace name must be "incubator", got "${marketplace.name}" — a beta→main merge leaked the beta channel files; use scripts/release.sh to promote`,
    );
  }
  if (claudeManifest && !SEMVER_RE.test(claudeManifest.version ?? "")) {
    errors.push(
      `main: .claude-plugin/plugin.json must pin a semver version (got ${JSON.stringify(claudeManifest.version)}) — without it every commit on main ships straight to stable users`,
    );
  }
  if (codexManifest && !SEMVER_RE.test(codexManifest.version ?? "")) {
    errors.push(`main: .codex-plugin/plugin.json must pin a semver version (got ${JSON.stringify(codexManifest.version)})`);
  }
  if (
    claudeManifest &&
    codexManifest &&
    SEMVER_RE.test(claudeManifest.version ?? "") &&
    SEMVER_RE.test(codexManifest.version ?? "") &&
    claudeManifest.version !== codexManifest.version
  ) {
    errors.push(
      `main: manifest versions disagree (.claude-plugin ${claudeManifest.version} vs .codex-plugin ${codexManifest.version})`,
    );
  }
}

if (branch === "beta") {
  if (marketplace && marketplace.name !== "incubator-beta") {
    errors.push(
      `beta: marketplace name must be "incubator-beta", got "${marketplace.name}" — beta registers as a second marketplace alongside stable and must not collide with it`,
    );
  }
  if (claudeManifest && "version" in claudeManifest) {
    errors.push(
      `beta: .claude-plugin/plugin.json must NOT declare a version (got ${JSON.stringify(claudeManifest.version)}) — a pinned version stops beta users from receiving new commits`,
    );
  }
}

if (errors.length > 0) {
  console.error(`check-channel: ${errors.length} invariant violation(s) on branch "${branch}":`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

console.log(`check-channel: all channel invariants hold for branch "${branch}" — OK`);
