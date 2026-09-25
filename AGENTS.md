
Deploy config: see deploy.md (managed by /inc-setup-deploy).

Distribution and host limits: see README.md and notes/multi-host-distribution.md.
Keep `skills/` root-native; edit shared metadata in `plugin.json`, then run `npm run manifests:sync` and refresh the package lock.
Run `npm test` for skill, distribution, hook, and API-client checks; `npm run smoke:pi` optionally verifies native discovery without model calls.

The Build API client is `scripts/inc-build.mjs` (feedback and IncPad `pad` commands); its tests run against a mock server in `tests/pad-client.test.mjs` using the `INCUBATOR_HOME` override.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
