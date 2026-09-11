// The picker and this gate share the skill's frontmatter as their source of truth.
// Keep the historical directory/tool alias here, not in transcript adapters.
import { readFileSync } from "node:fs";

// Match the repo skill validator's accepted name set (scripts/validate-skills.mjs):
// a YAML scalar matching this charset, written unquoted, single-quoted, or double-quoted.
const NAME_RE = /^[a-z0-9][a-z0-9:_-]*$/;

// A validator-legal name contains none of " ' or \, so stripping one matching quote
// pair is sufficient — no YAML escape handling is needed. Returns undefined when the
// name is absent or not a validator-legal scalar, so a genuinely malformed frontmatter
// still throws below (and the gate's error boundary fails open) while a valid quoted
// name resolves instead of throwing.
function parseSkillName(frontmatter) {
  const raw = /^name:[ \t]*(.*?)[ \t]*\r?$/m.exec(frontmatter)?.[1];
  if (raw == null) return undefined;
  const unquoted = (/^"([^"]*)"$/.exec(raw) ?? /^'([^']*)'$/.exec(raw))?.[1] ?? raw;
  return NAME_RE.test(unquoted) ? unquoted : undefined;
}

export function prWorkflowSkill() {
  const source = readFileSync(new URL("../skills/inc-commit-push-pr/SKILL.md", import.meta.url), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
  const name = parseSkillName(frontmatter ?? "");
  if (!name) throw new Error("PR workflow skill needs a frontmatter name");
  const legacyAlias = "inc-commit-push-pr";
  return {
    name,
    matches(value) {
      if (typeof value !== "string") return false;
      // Preserve Claude's existing plugin-qualified legacy-name recognition.
      return [name, legacyAlias].some((alias) => value === alias || value.endsWith(`:${alias}`));
    },
  };
}

export { parseSkillName };
