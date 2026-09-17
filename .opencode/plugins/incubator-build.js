import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const skillsDir = fileURLToPath(new URL("../../skills/", import.meta.url));

export default async function incubatorBuild() {
  return {
    config: async (config) => {
      config.skills ??= {};
      config.skills.paths ??= [];
      if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
      config.command ??= {};
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(skillsDir, entry.name, "SKILL.md");
        const content = readFileSync(file, "utf8");
        const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!block) continue;
        const fields = yaml.load(block[1]);
        if (!fields?.name || fields["user-invocable"] === false) continue;
        // Explicit paths work even for legacy names containing ':'. Preserve user commands.
        if (!(fields.name in config.command)) {
          config.command[fields.name] = {
            description: fields.description,
            template: `Read and follow the complete skill at ${JSON.stringify(file)}. Resolve bundled references relative to that file.\n\n$ARGUMENTS`,
          };
        }
      }
    },
  };
}
