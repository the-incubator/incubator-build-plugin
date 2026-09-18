import { fileURLToPath } from "node:url";

// Resolve against the installed extension, never the user's project cwd.
const skillsDir = fileURLToPath(new URL("../../skills/", import.meta.url));

export default function incubatorBuild(pi) {
  pi.on("resources_discover", async () => ({ skillPaths: [skillsDir] }));
}
