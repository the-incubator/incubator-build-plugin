# Codex hooks, upgrades, and plugin-local onboarding

## Diagnosis and supported boundary

The supported runtime verified here is Codex CLI 0.153.4 on macOS.
Real exec and interactive probes supplied both `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`, with cwd set to the user's project rather than the plugin directory.
The original commands resolved successfully in those probes.
The captain's historical missing-variable hook spam was **not reproduced** on this runtime.
This change is defensive hardening for a host/build missing the Claude alias.

The initiating trigger is a lifecycle event launching a hook command.
The relevant masking condition is the host-provided plugin root: removing the Claude alias exposes the old fallback to project cwd, while a populated alias hides it.
The visible symptom in the shell counterfactual is Node's module-not-found error and a nonzero hook exit.
With neither root available, the new command deliberately exits nonzero with an explicit plugin-root diagnostic instead of executing a similarly named project file.
With either root available, it executes the installed module, including paths containing spaces.
The Claude alias has precedence when both are present.

History commit `26b3aca` introduced the cwd fallback based on a claim that interactive hooks ran from the plugin directory.
The real current probes contradict that cwd assumption.
The installed-version source confirms both aliases in `codex-rs/hooks/src/engine/discovery.rs` and their propagation to the child in `engine/command_runner.rs`.
No hypothetical `CODEX_PLUGIN_ROOT` variable is used.
The PR-gate implementation, activation-recognition logic, and hook matcher are unchanged.

## Upgrade and onboarding findings

The previous updater always called Claude, even when the host was Codex.
The worker now uses the matching host, separate hourly throttle/log state, an exclusive update lock, bounded subprocesses, and refresh-before-install ordering.
Codex uses `plugin marketplace upgrade incubator` followed by `plugin add incubator-build@incubator`; its CLI has no `plugin install` subcommand.
Both native commands succeeded against a Git-backed marketplace in an isolated Codex home, without Codex model credentials.
This live check reinstalled the currently published version; it does not claim the unmerged release was fetched from GitHub.
The detached worker path and failure handling are also exercised by automated tests.
Updates take effect in a new session and do not bypass hook-trust review.

The prior plugin README sent new Codex users to a local parent-folder marketplace and incorrectly described hooks as Claude-only.
The README is now the canonical plugin-local onboarding guide and points to the GitHub owner/repo with `--ref main`, followed by `codex plugin add`.
A fresh native install produced `source_type = "git"`, the GitHub repository URL, `ref = "main"`, and an enabled plugin.
Codex accepted this repo's Claude-format marketplace manifest and loaded the Codex-format plugin manifest.
The toggle helper also installs the plugin, uses the repo itself for explicit local development, respects `CODEX_HOME`, and replaces a source through `marketplace add` without removing it first.
Normal fresh installs default to Git; intentional local development sources are not auto-migrated by the updater.

Codex model login, GitHub repository access, and Incubator service enrollment are distinct.
The plugin-local guide explains each; absent service credentials leave telemetry inactive while skills, the PR gate, and the Git updater remain available.
The hosted installer in the separate `incubator-build-app` repository remains outside this change and is still Claude-specific in the inspected source.
No app-repo or live global plugin configuration was modified.

## Validation

```bash
npm run test:hooks
npm run test:skills
bash -n scripts/toggle-local.sh
```

The hook suite covers every manifest invocation with either root, both roots, an empty Claude alias, neither root, and paths with spaces.
The missing-root case runs from the real plugin cwd to prove the old implicit fallback cannot mask a missing binding.
All six hook-resolution tests fail against the original manifest and pass against the fixed manifest.
The existing PR-gate suite remains green, including genuine activation and unreadable-identity cases; an additional test sends a non-activated PR payload through the resolved manifest command and verifies denial without executing any PR operation.
Updater tests cover both hosts, local-source preservation, refresh/install failures, unavailable CLI, invalid JSON, timeouts, throttling, forced retries, concurrency, stale locks, inherited host variables, symlinks, and the detached worker.
Onboarding tests cover a fresh Git install, local-to-Git conversion, explicit local development, declining the helper, and registration failure.
CI now runs the hook suite as well as skill validation.

The optional native integration check requires an installed Codex CLI:

```bash
node notes/codex-hooks-upgrade/smoke.mjs
```

It creates isolated HOME/CODEX_HOME and a plugin cache whose path includes spaces, then starts the real Codex process against a local deterministic Responses server.
A real shell tool executes a harmless printf command.
Observers capture SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, and SessionEnd, with both plugin-root aliases and project cwd verified for every event.
The process completes successfully without hook errors.
This proves the runtime integration; the response fixture is not a live model-quality or account-authentication test.
The updater and telemetry are disabled only in this hook-lifecycle fixture, with updater behavior checked separately above.
Hook trust is bypassed only for this reviewed isolated fixture; production code does not bypass it.
The script prints its evidence directory and retains the records there for inspection.
Set `TMPDIR` to a directory inside your worktree if all scratch writes must remain local.
