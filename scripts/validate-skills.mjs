#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const SKILLS_DIR = join(REPO_ROOT, "skills");

const NAME_RE = /^[a-z0-9][a-z0-9:_-]*$/;
const MAX_DESCRIPTION = 1024;
const REQUIRED_FIELDS = ["name", "description"];
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "version",
  "allowed-tools",
  "disable-model-invocation",
  "user-invocable",
  "argument-hint",
  "arguments",
  "when_to_use",
]);

const errors = [];
const warnings = [];

function err(file, msg) {
  errors.push({ file, msg });
}
function warn(file, msg) {
  warnings.push({ file, msg });
}

function parseFrontmatter(source, file) {
  if (!source.startsWith("---\n")) {
    err(file, "missing frontmatter (file must start with '---')");
    return null;
  }
  const end = source.indexOf("\n---", 4);
  if (end === -1) {
    err(file, "frontmatter is not closed with '---'");
    return null;
  }
  const body = source.slice(4, end);
  try {
    const parsed = yaml.load(body);
    if (parsed === null || typeof parsed !== "object") {
      err(file, "frontmatter is empty or not an object");
      return null;
    }
    return { frontmatter: parsed, content: source.slice(end + 4) };
  } catch (e) {
    err(file, `invalid YAML frontmatter: ${e.message}`);
    return null;
  }
}

function validateFrontmatter(fm, file) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in fm)) {
      err(file, `missing required field: ${field}`);
    }
  }

  if (typeof fm.name === "string") {
    if (!NAME_RE.test(fm.name)) {
      err(file, `'name' must match ${NAME_RE}, got: ${JSON.stringify(fm.name)}`);
    }
  } else if ("name" in fm) {
    err(file, `'name' must be a string, got ${typeof fm.name}`);
  }

  if ("description" in fm) {
    if (typeof fm.description !== "string") {
      err(file, `'description' must be a string`);
    } else {
      const d = fm.description.trim();
      if (d.length === 0) err(file, `'description' is empty`);
      if (d.length > MAX_DESCRIPTION)
        err(file, `'description' is ${d.length} chars, max ${MAX_DESCRIPTION}`);
    }
  }

  if ("allowed-tools" in fm) {
    const t = fm["allowed-tools"];
    if (typeof t !== "string" && !Array.isArray(t)) {
      err(file, `'allowed-tools' must be a string or array`);
    }
  }

  for (const key of Object.keys(fm)) {
    if (!KNOWN_FIELDS.has(key)) {
      warn(file, `unknown frontmatter field: ${key}`);
    }
  }

  return fm;
}

function validateRelativeLinks(content, errKey, skillFile) {
  const skillDir = dirname(skillFile);
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(content)) !== null) {
    const target = m[1].split("#")[0].split("?")[0].trim();
    if (!target) continue;
    if (/^[a-z]+:\/\//i.test(target)) continue;
    if (target.startsWith("mailto:")) continue;
    if (target.startsWith("#")) continue;
    if (target.startsWith("/")) continue;
    const resolved = resolve(skillDir, target);
    if (!existsSync(resolved)) {
      err(errKey, `broken relative link: ${target}`);
    }
  }
}

function listSkills() {
  if (!existsSync(SKILLS_DIR)) {
    err(SKILLS_DIR, "skills/ directory does not exist");
    return [];
  }
  return readdirSync(SKILLS_DIR)
    .map((name) => join(SKILLS_DIR, name))
    .filter((p) => statSync(p).isDirectory());
}

function main() {
  const skills = listSkills();
  const nameToFiles = new Map();

  for (const skillDir of skills) {
    const skillFile = join(skillDir, "SKILL.md");
    const rel = relative(REPO_ROOT, skillFile);
    if (!existsSync(skillFile)) {
      err(rel, "SKILL.md not found in skill directory");
      continue;
    }
    const source = readFileSync(skillFile, "utf8");
    const parsed = parseFrontmatter(source, rel);
    if (!parsed) continue;
    const fm = validateFrontmatter(parsed.frontmatter, rel);
    validateRelativeLinks(parsed.content, rel, skillFile);

    if (typeof fm.name === "string") {
      const list = nameToFiles.get(fm.name) ?? [];
      list.push(rel);
      nameToFiles.set(fm.name, list);
    }
  }

  for (const [name, files] of nameToFiles) {
    if (files.length > 1) {
      for (const f of files) {
        err(f, `duplicate skill name '${name}' also used in: ${files.filter((x) => x !== f).join(", ")}`);
      }
    }
  }

  const total = skills.length;
  const failed = new Set(errors.map((e) => e.file)).size;

  if (warnings.length) {
    console.log("\nWarnings:");
    for (const { file, msg } of warnings) console.log(`  ${file}: ${msg}`);
  }

  if (errors.length) {
    console.log("\nErrors:");
    for (const { file, msg } of errors) console.log(`  ${file}: ${msg}`);
    console.log(`\n${failed}/${total} skills failed validation (${errors.length} errors)`);
    process.exit(1);
  }

  console.log(`\nAll ${total} skills passed validation.`);
}

main();
