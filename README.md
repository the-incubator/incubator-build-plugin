# Incubator Build Plugin

Incubator Build provides agent skills for planning, PR review, debugging, resolving review feedback, shipping pull requests, publishing hosted IncPad review pages (`inc-pad`), and generating project-local verification skills that drive the real app to prove its behavior.
The full skill catalog lives in [skills/inc-guide/SKILL.md](skills/inc-guide/SKILL.md).

## Install and invoke

All hosts use the root `skills/` corpus, including its scripts and references.
Persona definitions under `agents/` remain install-root-accessible prompt assets; hosts do not need to register Claude custom agents to read them.
This distribution follows [Compound Engineering's native adapter model](notes/multi-host-distribution.md), not generated copies of skills.
Install only trusted code, authenticate Git access if required, and start a new host session after installing or updating.
Adapters and bundled Node scripts require Node.js 20.11+; workflow-specific tools such as Git, GitHub CLI, Bash, jq, Python, and browser drivers remain prerequisites where the selected skill uses them.

| Host | Install | Invoke / smoke check |
| --- | --- | --- |
| Claude Code | `/plugin marketplace add the-incubator/incubator-build-plugin`, then `/plugin install incubator-build@incubator` | `/inc-guide` |
| Codex app | Plugins → Create menu → Add marketplace: source `the-incubator/incubator-build-plugin`, Git ref `main`, sparse paths blank; install **Incubator Build** | Restart, then `$inc-guide` |
| Codex CLI | `codex plugin marketplace add the-incubator/incubator-build-plugin --ref main`, then `codex plugin add incubator-build@incubator` | `$inc-guide`; see detailed onboarding below |
| Cursor | Link a retained checkout using `node /absolute/path/to/incubator-build-plugin/scripts/install-skills.mjs cursor --project` from the target project | Start a new chat, select `inc-guide` in `/` skills, or ask to read its installed `SKILL.md` |
| Pi | `pi install git:github.com/the-incubator/incubator-build-plugin` | `/reload`, then `/skill:inc-guide` |
| oh-my-pi (OMP) | `omp plugin marketplace add the-incubator/incubator-build-plugin`, then `omp plugin install incubator-build@incubator` | `/reload-plugins`, then `/skill:inc-guide` |
| Kimi Code CLI | `/plugins install https://github.com/the-incubator/incubator-build-plugin` | `/reload`, then ask to use `inc-guide` |
| Grok Build CLI | `grok plugin install the-incubator/incubator-build-plugin` | Restart; ask to use `inc-guide` |
| Devin CLI | `devin plugins install the-incubator/incubator-build-plugin` | `devin plugins info incubator-build`; select the guide under `/incubator-build:` |
| OpenCode | Add `"incubator-build-plugin@git+https://github.com/the-incubator/incubator-build-plugin.git"` to `opencode.json`'s `plugin` array | Restart, then `/inc-guide` |
| Cline | Enable **Settings → Features → Enable Skills**; run `node /absolute/path/to/incubator-build-plugin/scripts/install-skills.mjs cline --project` | New task: ask to use `inc-guide` |
| VS Code Copilot | `Chat: Install Plugin from Source` → `the-incubator/incubator-build-plugin` → `incubator-build` | New chat: ask to use `inc-guide` |
| Copilot CLI | `copilot plugin marketplace add the-incubator/incubator-build-plugin`, then `copilot plugin install incubator-build@incubator` | New session: ask to use `inc-guide` |
| Factory Droid | `droid plugin marketplace add https://github.com/the-incubator/incubator-build-plugin`, then `droid plugin install incubator-build@incubator` | New session: ask to use `inc-guide` |
| Qwen Code | `qwen extensions install the-incubator/incubator-build-plugin:incubator-build` | New session: ask to use `inc-guide` |
| Antigravity CLI | `agy plugin install https://github.com/the-incubator/incubator-build-plugin` | `agy plugin list`; ask to use `inc-guide` |

The added native manifests are schema/path-validated, not a claim of an end-to-end runtime test on every host.
Existing Claude/Codex hook runtime evidence is linked below; new-host smoke evidence and limitations are in [distribution notes](notes/multi-host-distribution.md).
Skill names use a dash prefix (`inc-guide`) and match their directory names, so every host picker shows the same name; colon-era `inc:*` names from releases before 0.23.0 remain recognized by the PR gate as legacy aliases.
If a picker does not expose a skill, ask the agent to read and follow `<install-root>/skills/inc-guide/SKILL.md` explicitly rather than guessing slash syntax.
That fallback loads the workflow, not hook activation evidence.

### Cursor and Cline checkouts

Retain a checkout of this repository at a stable absolute path (GitHub CLI users can use `gh-axi repo clone the-incubator/incubator-build-plugin`).
Run `npm ci --omit=dev` there before the link installer.
Run the installer from the target project for `--project`, or use `--global` for `~/.cursor/skills/` or `~/.cline/skills/`.
The installer links individual skill directories, is idempotent, and reports conflicts without overwriting user files or foreign symlinks.
Keep the checkout: scripts and persona references resolve back to it through real paths.
Update it with `git pull --ff-only`, rerun the installer for new skills, and restart the host.
Remove only the links printed by the installer to uninstall; never delete an entire shared skills directory.
Cline omits manual-only skills by default; `--include-manual` opts in knowing Cline may auto-activate them.
Omitting that flag later does not remove links already installed; remove those links explicitly to revoke the opt-in.

`.cursor-plugin/` also supplies native plugin/marketplace metadata for private distribution or a future Cursor marketplace listing.
This repository is not assumed to be listed publicly: do not rely on `/add-plugin incubator-build` unless your Cursor catalog actually offers it.
Grok Bot uses Cursor's account-level plugin library, not the Grok Build CLI or local project symlinks; it needs that catalog listing and is not covered by the checkout installation.

### Other native adapters

Kimi can alternatively browse `.kimi-plugin/marketplace.json` through `/plugins marketplace https://raw.githubusercontent.com/the-incubator/incubator-build-plugin/main/.kimi-plugin/marketplace.json`.
OMP's versioned catalog supports `omp plugin upgrade incubator-build@incubator`; its Pi-compatible package metadata keeps root skills discoverable without a converter.
Use `pi update git:github.com/the-incubator/incubator-build-plugin` to update an unpinned Pi package; Git `@ref` installs are pinned and must be explicitly reinstalled at a new ref.
OpenCode adds an absolute skill path and commands without replacing user configuration or commands.
See [OpenCode](.opencode/INSTALL.md), [Cline](.cline/INSTALL.md), and [Antigravity](.agy/INSTALL.md) for adapter details.

### Workflow and host boundaries

- `inc-review-and-pr` reviews, commits, opens/refreshes, watches, and resolves feedback, then **stops before merge**.
  `inc-ship-it` additionally runs merge/deploy gates and should only be invoked when merging is intended.
- Cursor/Pi and other hosts without a nested Skill tool read and follow linked sibling `SKILL.md` files inline.
  Every child gate, confirmation, stop condition, and explicit argument remains binding.
  See [composition rules](skills/inc-guide/references/host-compatibility.md).
- Review/resolver fan-out requires independent subagents.
  Pi's minimal `resources_discover` extension only discovers content; install a compatible companion such as `pi install npm:pi-subagents` for independent review.
  A question extension is optional: without one the workflow asks inline and waits.
  If required subagents are unavailable, stop rather than substituting self-review.
- Claude/Codex hooks, telemetry, enrollment, and automatic updates are **not ported** to the additional hosts.
  If a compatibility host imports `hooks/hooks.json`, leave unsupported hooks disabled using that host's controls, or use a skills-only discovery path instead.
  Do not treat content installation as gate parity.
- Codex's existing PR gate recognizes host-written selected-skill activation, not arbitrary file reads.
  A file-based closeout may require directly invoking `$inc-commit-push-pr` on Codex; if denied, stop and report the gap.
  A full Codex closeout/gate rewrite and per-host hook parity are follow-ups, not part of this distribution.
- `inc-setup-claude-status-line` intentionally configures Claude only.
  `inc-worktree`'s automatic WorktreeCreate setup is Claude-specific; its status/prune script is portable.
  Service-backed skills still require their actual credentials and tools.

## Install on Codex

Use Codex CLI 0.153.4 or later, Git, and Node.js 20.11 or later on PATH.
The verified baseline is Codex 0.153.4 on macOS; hook commands use a POSIX shell.
Run these commands in your terminal:

```bash
codex plugin marketplace add the-incubator/incubator-build-plugin --ref main
codex plugin add incubator-build@incubator
```

This registers a **Git-backed** marketplace on `main`, installs the plugin, and enables it.
It also replaces an existing local `incubator` marketplace source when migrating an older installation.
No checkout or parent workspace is required.
Codex reads the repository's `.claude-plugin/marketplace.json` and the plugin's `.codex-plugin/plugin.json`; both formats are supported by the verified CLI.

Start a new Codex session and review/approve the plugin hooks when Codex prompts.
The bundled `hooks/hooks.json` is discovered automatically, so there is no separate manual hooks-file copy.
Updated commands may require renewed hook trust; the installer and updater do not bypass that review.

Verify the source with:

```bash
codex plugin marketplace list --json
```

The `incubator` entry should have `marketplaceSource.sourceType` equal to `git` and its source should be the GitHub repository above.
The `marketplaces.incubator` section in `${CODEX_HOME:-$HOME/.codex}/config.toml` should include `ref = "main"`.
Avoid a local-folder marketplace for normal use: refreshing Git marketplaces cannot fetch newer code into a local source.

### Authentication on a clean machine

Sign in to Codex with `codex login` before using the agent.
That authenticates model access; it does not authenticate GitHub downloads.
If Git reports a private-repository/authentication error, authenticate an account with repository access through your Git credential helper (for GitHub CLI users, `gh auth login` followed by `gh auth setup-git`), then rerun the install commands.
No Claude CLI or Incubator API key is required to install the skills, run the PR gate, or update this Git marketplace.

Incubator service credentials are separate from Codex and GitHub authentication.
Telemetry hooks read `~/.claude/incubator/credentials.json` on both hosts and do nothing when credentials are absent; installing this plugin alone does not enroll a new device in telemetry.
Service-backed skills may require an Incubator API key from your administrator.
The hosted `incubator-build-app` installer currently provisions Claude-specific enrollment and is not the Codex installation path documented here.

### Automatic and forced updates

On Claude and Codex, SessionStart and SessionEnd schedule an update in the background, at most once per hour per host.
On Codex, the worker refreshes the configured Git marketplace with `codex plugin marketplace upgrade incubator`, then reinstalls with `codex plugin add incubator-build@incubator`.
On Claude, it retains `claude plugin marketplace update incubator` followed by `claude plugin update incubator-build@incubator`.
A failed refresh prevents installation from a stale snapshot.
Concurrent sessions serialize the update operation, and failures are logged without blocking the session.
Start a new session to load the installed version; already-loaded skills and hooks are not replaced in memory.

Codex logs updates at `${CODEX_HOME:-$HOME/.codex}/incubator/logs/plugin-update.log`.
Claude uses `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/incubator/logs/plugin-update.log`.
Intentional local development marketplaces are left in place, with the stable migration command recorded in the Codex log.
Set `INCUBATOR_PLUGIN_UPDATE_DISABLED=1` to opt out of this updater.

For a one-step immediate update from a plugin checkout, bypassing the hourly throttle:

```bash
node hooks/plugin-update.mjs --host codex --force
```

This runs the same refresh/install operation in the foreground and reports failure through its exit status and log.
An older installed release must first use the two installation commands above to receive this updater.

## Local plugin development

Local sources are for deliberately testing a checkout, and do not track GitHub releases.
From this repository:

```bash
scripts/toggle-local.sh codex local
scripts/toggle-local.sh claude local
```

To return Codex to stable Git-backed `main` and reinstall:

```bash
scripts/toggle-local.sh codex prod
```

The helper shows its actions and asks before switching.
For a fresh Codex installation, its default target is stable Git rather than local.

## Validation and smoke verification

From a checkout, run:

```bash
npm ci
npm test
npm pack --dry-run
# Optional live discovery smoke, with Pi installed and no model calls:
npm run smoke:pi
```

`npm test` validates skill metadata/links, generated manifest parity, install-root paths, packaged resource declarations, adapter discovery, link-install safety, composition/persona references, and the existing hook suite.
After installation, load only the read-only guide first and verify it resolves its sibling and persona files from the installed corpus while the current directory is an unrelated project.
Do not use a ship or merge workflow as an installation smoke test.
For a later authorized closeout test, use a disposable branch and confirm a missing review artifact or required subagent stops the chain; `inc-review-and-pr` must never invoke merge.

Shared release metadata lives in `plugin.json`; after changing it, run `npm run manifests:sync` and `npm install --package-lock-only`.
The check rejects drift across host manifests, package version, and OMP's versioned catalog.
The root intentionally omits an Agent Plugins `$schema` to retain CE's legacy discovery posture for long skills and extended frontmatter.

## Hook compatibility

Hooks are supported on Claude Code and Codex only.
Every command resolves `CLAUDE_PLUGIN_ROOT` first, then `PLUGIN_ROOT`, and reports an explicit error if neither exists.
Paths containing spaces are supported; hooks never assume the current project is the plugin directory.

Real Codex 0.153.4 exec and interactive probes supplied both variables and resolved the previous commands correctly.
The root change is defensive hardening for a host/build missing the Claude alias, not a claim that the reported historical hook-error spam was reproduced.
See [runtime evidence and regression checks](notes/codex-hooks-upgrade/README.md).
