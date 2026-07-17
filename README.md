# Incubator Build Plugin

Incubator Build provides agent skills for planning, PR review, debugging, resolving review feedback, and shipping pull requests.

## Channels and releases

The plugin ships on two channels (see [RELEASING.md](RELEASING.md)):

- **stable** — the `main` branch, marketplace `incubator`. End users live here; code arrives only through a versioned release.
- **beta** — the `beta` branch, marketplace `incubator-beta`. Every merged PR ships here immediately for dogfooding.

Feature PRs target `beta`. Promoting beta to a stable release is gated on the routing eval suite (`npm run test:evals`) and done with `scripts/release.sh <version>`.

Join the beta channel:

```bash
scripts/toggle-local.sh claude beta
```

## Codex Local Install

This repository can be registered as a local Codex marketplace because it includes:

- `.agents/plugins/marketplace.json` (in the parent workspace root, one level above this plugin folder)
- `.codex-plugin/plugin.json`
- `skills/*/SKILL.md`

Register the local marketplace from this repository:

```bash
scripts/toggle-local.sh codex local
```

Then restart Codex and enable `incubator-build@incubator` in the Codex app/plugin UI if it is not already enabled.

The helper registers the workspace root one directory above this plugin, because Codex expects a marketplace root with a `.agents/plugins/marketplace.json` file that points at the plugin folder.

## Claude Local Install

The same helper still supports Claude Code:

```bash
scripts/toggle-local.sh claude local
```

## Compatibility Notes

Codex loads the skill bundle from `.codex-plugin/plugin.json`. Claude-specific telemetry hooks under `hooks/` remain Claude-only until Codex exposes a compatible hook payload and lifecycle API.
