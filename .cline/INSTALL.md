# Cline

Enable **Settings → Features → Enable Skills**.
Retain a checkout of this repository and run `npm ci --omit=dev` in it.
From the target project, run:

```bash
node /absolute/path/to/incubator-build-plugin/scripts/install-skills.mjs cline --project
```

Use `--global` instead for `~/.cline/skills/`.
The installer preserves user directories, foreign symlinks, and broken links, reporting conflicts with a nonzero exit status.
Repeated installation of the same checkout is safe.
Manual-only skills are omitted unless `--include-manual` is passed; Cline may auto-activate them when included.
Revoking that opt-in requires removing the previously installed manual-only links explicitly.

Start a new task and ask to use `inc:guide`.
If a strict name validator omits the legacy colon-named skills, explicitly ask to read and follow the absolute `skills/inc-guide/SKILL.md` path in the checkout.
Update with `git pull --ff-only`, rerun the installer to link new skills, and start a new task.
Remove only this installer's skill symlinks to uninstall, not the shared `.cline/skills/` directory.
Keep the checkout while links exist so sibling scripts and persona assets remain accessible.
See the [host matrix and limitations](../README.md).
