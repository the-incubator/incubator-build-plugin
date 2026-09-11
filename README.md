# Incubator Build Plugin

Incubator Build provides agent skills for planning, PR review, debugging, resolving review feedback, shipping pull requests, and generating project-local verification skills that drive the real app to prove its behavior.

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

On both hosts, SessionStart and SessionEnd schedule an update in the background, at most once per hour per host.
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

## Hook compatibility

Hooks run on both Claude Code and Codex.
Every command resolves `CLAUDE_PLUGIN_ROOT` first, then `PLUGIN_ROOT`, and reports an explicit error if neither exists.
Paths containing spaces are supported; hooks never assume the current project is the plugin directory.

Real Codex 0.153.4 exec and interactive probes supplied both variables and resolved the previous commands correctly.
The root change is defensive hardening for a host/build missing the Claude alias, not a claim that the reported historical hook-error spam was reproduced.
See [runtime evidence and regression checks](notes/codex-hooks-upgrade/README.md).
