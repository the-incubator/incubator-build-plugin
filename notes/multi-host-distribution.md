# Multi-host distribution

## Design source

Studied [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) at commit `082c83e0537c803ac1d927daafc2e6eb6962dedf` before implementation.
The reference checkout was inspected locally, not vendored into this repository.
Relevant upstream files:

- [Native installation matrix](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/README.md).
- [Pi resource discovery](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/.pi/extensions/compound-engineering.ts) and [OpenCode adapter](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/.opencode/plugins/compound-engineering.js).
- [Root manifest routing caveats](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/docs/specs/agent-plugins.md), [OMP discovery and catalog versions](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/docs/specs/omp.md), and [Devin's fixed manifest shape](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/docs/specs/devin.md).

Adapted the architecture, not CE's product metadata or entire converter toolchain:

- Keep a single root-native `skills/` corpus and root-accessible persona files.
- Generate host-specific metadata from root `plugin.json` using `npm run manifests:sync`.
- Retain schema-less root metadata to avoid CE's documented strict-provider routing and long-skill truncation issues.
- Pi gets a minimal dependency-free JavaScript `resources_discover` extension plus package skill declarations.
- OpenCode gets its native package entry point, explicit skill paths, and additive commands pointing to complete skill files.
  Use a real YAML parser already present in the repository, now a production dependency, rather than a second frontmatter parser.
- Cursor/Cline get a non-destructive link installer with realpath-aware prose for shared scripts and persona assets.
  Do not pretend this plugin already has CE's public Cursor marketplace listing.
- Keep existing `inc:*` invocation names and the Claude/Codex hooks unchanged.
  The portable composition reference replaces nested Skill-tool assumptions with explicit sibling-file execution and capability checks.

## Verification performed

On September 17, 2026:

- `npm test`: 27 skills validated, 9 distribution tests passed, and 53 existing hook tests passed.
- Distribution tests cover generated metadata/version parity, declared skill paths, package resources, Pi startup/reload callbacks, additive/idempotent OpenCode configuration, relocated adapter paths with spaces, relative links, persona paths, closeout handoffs, and Cursor/Cline link safety.
- `npm run smoke:pi`: Pi `0.85.1` discovered all 27 skills from an actual local package installation in an isolated profile and unrelated project directory.
  A separate isolated extension-only load also discovered all 27, proving the `resources_discover` callback works independently of `package.json` skill discovery.
  No model calls, prompts, user configuration changes, PR operations, or workflow execution were involved.
- Codex CLI `0.153.4`: added the packed repository as a local marketplace and installed `incubator-build@incubator` at version `0.21.0` in an isolated profile.
  The fixture kept source and `CODEX_HOME` as siblings: nesting a Codex profile inside the source being copied causes recursive cache copying and is not a valid local-install test layout.
  No model session, hook approval bypass, or PR creation was attempted.
- `claude plugin validate .claude-plugin/plugin.json`: passed with existing warnings about root `CLAUDE.md` not being plugin context and `agents/inc-staff-reviewer.agent.md` lacking frontmatter.
  Strict mode treats those warnings as errors; this change does not claim a strict-clean legacy agent corpus.
- `claude plugin validate .claude-plugin/marketplace.json`: passed without warnings.
- `npm pack --dry-run`: resource coverage checked automatically; local `.context`, `.claude` project settings, dependencies, and deployment configuration are excluded.
- Existing [Codex hook runtime evidence](codex-hooks-upgrade/README.md) and [PR-gate replay evidence](codex-pr-gate/README.md) remain authoritative for those paths.

OpenCode is tested through its native config callback, not a live OpenCode agent session.
Cursor/Cline filesystem installs are exercised in isolated directories; their interactive pickers were not driven.
Other new host manifests are checked against the CE-derived field shapes and install-root paths, not live authenticated host sessions.
The [manual acceptance checklist](../workflow/test-plans/test-plan-multi-host-distribution-2026-09-17.md) records the remaining interactive tests.

## Deliberate boundaries and follow-ups

### PR gates and hooks

No full Codex PR-gate rewrite or new-host hook parity is included.
Codex selected-skill metadata remains distinct from an ordinary file read; a nested file-based closeout can therefore hit the existing PR gate despite following the right prose.
Use direct native `$inc-commit-push-pr` activation when needed, and stop/report any denial without altering hooks or transcripts.
Follow-up: capture authorized live Codex closeout behavior, then design compositional activation evidence independently of distribution.

Some compatibility hosts may discover the existing root hook bundle automatically.
Those hosts must keep unsupported hooks disabled through their own controls or use skills-only discovery; this distribution does not validate their hook input, transcript, permission, or environment contracts.
Follow-up: test each target's lifecycle and approval semantics before claiming hook/telemetry/updater support.

### Skill discovery and capabilities

Legacy colon names and name/directory mismatches are preserved to avoid breaking the installed workflow API.
Pi's real loader accepts them; stricter clients may not.
For those clients, explicit file reading is the supported content fallback, not a claim of native command registration.
Follow-up: if a strict client is a priority, validate its loader and design a backward-compatible alias/emitted manifest strategy without duplicating the source corpus.

Independent review requires real subagent support; Pi needs a companion extension.
Sequential independent calls can replace parallel scheduling, but same-agent self-review cannot replace required independence.
No missing capability is treated as a passing review.
Blocking questions may fall back to explicit inline questions that wait for a reply.

Claude status-line configuration and WorktreeCreate hook setup remain intentionally Claude-specific.
Grok Bot needs an account-level Cursor marketplace install; local Cursor links do not claim to install on its remote computer.
Marketplace publication, Kiro/legacy Gemini converter support, and host-specific permissions translation are separate follow-ups.
