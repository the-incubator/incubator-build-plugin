// The picker and this gate share the skill's frontmatter as their source of truth.
// Keep the historical directory/tool alias here, not in transcript adapters.
import { readFileSync } from "node:fs";

export function prWorkflowSkill() {
  const source = readFileSync(new URL("../skills/inc-commit-push-pr/SKILL.md", import.meta.url), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
  const name = /^name: ([a-z0-9][a-z0-9:_-]*)\r?$/m.exec(frontmatter ?? "")?.[1];
  if (!name) throw new Error("PR workflow skill needs a plain frontmatter name");
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
