// The picker and this gate share the skill's frontmatter as their source of truth.
// Keep the historical name aliases here, not in transcript adapters.
import { readFileSync } from "node:fs";

// The gate reads only the canonical simple frontmatter form: a plain unquoted
// scalar name. scripts/validate-skills.mjs asserts this skill keeps that form, so
// an exotic-but-YAML-legal spelling (quotes, a trailing comment, a block/folded
// scalar) is caught at CI, not at runtime. If one ever did reach the runtime
// unparsed, parseSkillName returns undefined and prWorkflowSkill throws, and the
// gate fails CLOSED (denies the PR) rather than failing open — see gh-pr-gate.mjs.
// This is deliberately not a YAML parser: robustness comes from failing closed by
// construction, not from enumerating every legal spelling here.
export function parseSkillName(frontmatter) {
  return /^name: ([a-z0-9][a-z0-9:_-]*)\r?$/m.exec(frontmatter ?? "")?.[1];
}

// `source` is an optional override of the SKILL.md text, used only by tests to
// exercise malformed identities; production callers pass nothing and read the file.
export function prWorkflowSkill(source) {
  const text = source ?? readFileSync(new URL("../skills/inc-commit-push-pr/SKILL.md", import.meta.url), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  const name = parseSkillName(frontmatter);
  if (!name) throw new Error("PR workflow skill frontmatter name is unreadable");
  // Colon-era names from releases before 0.23.0. Transcripts and hosts that
  // activated the skill under those names must still satisfy the gate.
  const legacyAliases = ["inc:commit-push-pr-4", "inc:commit-push-pr"];
  return {
    name,
    matches(value) {
      if (typeof value !== "string") return false;
      // Preserve Claude's existing plugin-qualified legacy-name recognition.
      return [name, ...legacyAliases].some((alias) => value === alias || value.endsWith(`:${alias}`));
    },
  };
}
