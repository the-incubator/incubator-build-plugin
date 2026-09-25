#!/usr/bin/env node
// Link the shared corpus for hosts without a usable direct plugin installation.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const args = process.argv.slice(2);
const host = args.shift();
if (!["cursor", "cline"].includes(host) || args.some((a) => !["--global", "--project", "--include-manual"].includes(a)) || (args.includes("--global") && args.includes("--project"))) {
  console.error("Usage: node scripts/install-skills.mjs <cursor|cline> [--global|--project] [--include-manual]");
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(args.includes("--project") ? process.cwd() : homedir(), `.${host}`, "skills");
mkdirSync(destination, { recursive: true });
let conflicts = 0;
for (const entry of readdirSync(join(root, "skills"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = join(root, "skills", entry.name);
  const content = readFileSync(join(source, "SKILL.md"), "utf8");
  const fields = yaml.load(content.match(/^---\n([\s\S]*?)\n---/)[1]);
  // Cline has no manual-only invocation guard. Never silently auto-enable these.
  if (host === "cline" && fields["disable-model-invocation"] === true && !args.includes("--include-manual")) {
    console.log(`Omitted manual-only skill: ${entry.name}`);
    continue;
  }
  const target = join(destination, entry.name);
  let existing;
  try { existing = lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    let same = false;
    try { same = existing.isSymbolicLink() && realpathSync(target) === realpathSync(source); } catch { /* broken link is a conflict */ }
    if (same) continue;
    console.error(`Conflict (left unchanged): ${target}`);
    conflicts++;
    continue;
  }
  symlinkSync(source, target, "dir");
  console.log(`Linked ${target} -> ${source}`);
}
// A skill retired from this checkout leaves its old link dangling; remove links
// that point into this checkout's skills/ but whose target is gone. Links into
// other checkouts or user-made links are left alone.
const skillsRoot = join(root, "skills");
for (const entry of readdirSync(destination, { withFileTypes: true })) {
  if (!entry.isSymbolicLink()) continue;
  const link = join(destination, entry.name);
  const target = resolve(destination, readlinkSync(link));
  if (target.startsWith(skillsRoot + "/") && !existsSync(target)) {
    unlinkSync(link);
    console.log(`Removed retired link ${link} -> ${target}`);
  }
}
if (host === "cline" && args.includes("--include-manual")) console.warn("Manual-only skills included: Cline may auto-activate them.");
if (conflicts) process.exitCode = 1;
