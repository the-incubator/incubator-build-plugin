---
name: inc:setup-claude-status-line
description: Use when the user wants to install the captain's Claude Code status line — a two-line statusLine that shows model + effort + context % + project/branch on line 1 and 5h/weekly/weekly-all usage bars with pace badges on line 2 (the 5h bar also shows a reset countdown once it enters the warning zone). Triggers on "setup the status line", "install the claude status line", "set up the status line", "add the usage bars to my status line", or "/inc:setup-claude-status-line". Copies the bundled statusline/ tree to a self-contained install target (default ~/.claude/statusline/), resolves a tsx runner, MERGES the statusLine command into ~/.claude/settings.json without touching other keys, and verifies with a sample payload. The usage line needs macOS + a logged-in Claude Code; elsewhere the base line still renders.
allowed-tools: Read, Write, Edit, AskUserQuestion, Bash(command -v *), Bash(cp *), Bash(cmp *), Bash(diff *), Bash(mkdir *), Bash(test *), Bash(ls *), Bash(cat *), Bash(jq *), Bash(mv *), Bash(tsx *), Bash(npx *), Bash(echo *), Bash(dirname *), Bash(find *)
argument-hint: "[optional: install target dir, e.g. '~/.claude/statusline']"
---

# Setup Claude Status Line — Install the Captain's Two-Line statusLine

Install the captain's Claude Code status line for the current user.
It is a TypeScript script that Claude Code runs through `tsx` via the `statusLine` setting, and it renders two lines:

- **Line 1:** model name + effort level (dim), output style (only when non-default), context % (yellow above 50, red above 70), and the project dir + git branch.
- **Line 2:** usage bars — 5h session, model-scoped weekly, and weekly-all quota — each a 5-cell bar + colored percent, with pace badges like `(1.4x)` and a reset countdown like `↻6d`. The 5h bar also appends its own reset countdown once it enters the warning zone (70%+, when the bar turns yellow), so you can see how soon the window comes back.

Line 2 reads the Claude Code OAuth token from the macOS Keychain, calls the Anthropic usage endpoint, and caches for 60s.
On any failure it silently falls back to line 1 only, so the script is safe cross-platform: the usage line is effectively macOS-only, and everywhere else the base line still renders.

**What ships with this skill:** the byte-identical status line sources, bundled under this skill directory at [`statusline/`](statusline/statusline.ts).
The layout is self-contained — `statusline.ts` imports `./lib/*.js` and `./types/*.js`, and `tsx` resolves those `.js` specifiers to the `.ts` files:

```
statusline/
  statusline.ts
  lib/pace.ts
  lib/read-stdin.ts
  lib/usage.ts
  types/statusline-input.ts
```

**Locating the bundle:** in Claude Code the skill directory is `${CLAUDE_PLUGIN_ROOT}/skills/inc-setup-claude-status-line`.
In Codex, resolve it from the loaded skill path: this `SKILL.md` sits at the skill directory root, so the bundle is the `statusline/` folder next to it.
Below, `<bundle>` means that `statusline/` directory.

## User-invocable

When the user types `/inc:setup-claude-status-line`, run this skill.
An optional argument is the install target directory (e.g. `/inc:setup-claude-status-line ~/.claude/statusline`) — use it to skip the default.
Otherwise the default target is `<config>/statusline/`, where `<config>` is the active Claude config dir (`$CLAUDE_CONFIG_DIR` if set, else `~/.claude`).

## Step 1 — Copy the bundle to the install target

The install target is self-contained; the whole `statusline/` tree must land there so the relative imports resolve.
Resolve the active Claude config dir once and reuse it for both the install target and `settings.json` (Step 3), so a profile running with `CLAUDE_CONFIG_DIR` installs into that profile — the same directory the bundled runtime treats as authoritative in `getClaudeProfilePaths` (`lib/usage.ts`).
Default target: `<config>/statusline/` (`<config>` = `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`).

For each of the five files (`statusline.ts`, `lib/pace.ts`, `lib/read-stdin.ts`, `lib/usage.ts`, `types/statusline-input.ts`):

- If the target file does not exist, create parent dirs (`mkdir -p`) and copy it.
- If the target file exists and is **byte-identical** (`cmp -s`), it is a no-op — leave it.
- If the target file exists and **differs**, show a `diff` summary of the change and ask the user before overwriting.
  Do not overwrite a differing file without confirmation.

```bash
BUNDLE="<bundle>"                     # the statusline/ dir shipped with this skill
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"   # active Claude config dir (used again in Step 3)
TARGET="${TARGET:-$CFG/statusline}"   # custom target from the argument overrides this
for rel in statusline.ts lib/pace.ts lib/read-stdin.ts lib/usage.ts types/statusline-input.ts; do
  src="$BUNDLE/$rel"; dst="$TARGET/$rel"
  if [ ! -e "$dst" ]; then
    mkdir -p "$(dirname "$dst")" && cp "$src" "$dst" && echo "installed $rel"
  elif cmp -s "$src" "$dst"; then
    echo "unchanged $rel"
  else
    echo "DIFFERS $rel"; diff "$dst" "$src" || true   # ask before overwriting
  fi
done
```

## Step 2 — Resolve a tsx runner

The `statusLine` command must invoke `tsx`.
Claude Code runs the statusLine command in a shell initialized from the user's profile, so a `tsx` on the user's `PATH` resolves.
Resolve a runner in this order and remember the exact string you resolve (call it `<tsx>` below):

1. If `command -v tsx` succeeds → use the bare command `tsx`.
   Prefer the bare name over the absolute path: it stays valid if the binary moves, and it matches this skill's `Bash(tsx *)` allowed-tools so the Step 4 verification runs without an extra permission prompt.
2. Otherwise, if `command -v npx` succeeds → use `npx tsx`.
   This is a fallback, not an equal option: `npx` re-resolves the package on **every** status-line render (many per session), adding latency the script's own 60s cache is designed to avoid.
   Prefer steering the user to a global install (`npm i -g tsx`) and only fall back to `npx tsx` when they decline.
3. Otherwise neither is available — tell the user to install tsx with `npm i -g tsx` and **stop**.
   Do not write a `statusLine` command that cannot run.

```bash
if command -v tsx >/dev/null 2>&1; then TSX="tsx"
elif command -v npx >/dev/null 2>&1; then TSX="npx tsx"   # fallback: adds per-render latency
else echo "NO_TSX"; fi
```

## Step 3 — Merge the statusLine setting into ~/.claude/settings.json

**Merge, never rewrite.**
`~/.claude/settings.json` holds many unrelated keys — preserve every one of them.
Set only:

```json
"statusLine": {
  "type": "command",
  "command": "<tsx> \"<target>/statusline.ts\""
}
```

where `<tsx>` is the Step 2 runner and `<target>` is the Step 1 install directory (default `~/.claude/statusline`).
Use the **same** target you copied the bundle to in Step 1 — if the user gave a custom target, the command must point there, not at the default.
**Double-quote the script path inside the command** so a target containing spaces or shell metacharacters still resolves when Claude Code runs the command through a shell; the default path has no spaces, but a custom target may.

Write it to the active profile's `settings.json` — `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set, else `~/.claude/settings.json`.
Writing to the default path while a custom config dir is active installs the setting into the wrong profile, so the status line never appears.

> **Shell state does not persist across separate Bash tool calls.**
> The `$CFG`, `$TARGET`, and `$TSX` variables from Steps 1–2 are gone by the time you run Step 3.
> Substitute the literal values you resolved directly into the command below (or run Steps 1–4 in one Bash invocation), so `command` is never written with an empty runner or the wrong path.

First read the existing value from the active config dir:

```bash
jq '.statusLine // "NONE"' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" 2>/dev/null || echo "NO_SETTINGS_FILE"
```

- If there is no `statusLine`, or it already equals the command you are about to write, merge it in.
- If a **different** `statusLine` already exists, show it to the user and confirm before replacing it.

Merge with `jq` so the rest of the file is untouched (write to a temp file, then move into place).
Set `CFG`, `TSX`, and `TARGET` to the literal Step 1/2 results in this same block:

```bash
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"  # active Claude config dir (same as Step 1)
TSX="tsx"                              # the Step 2 runner ("tsx" or "npx tsx")
TARGET="$CFG/statusline"               # the Step 1 install dir (custom target if given)
CMD="$TSX \"$TARGET/statusline.ts\""   # quote the path so a target with spaces still resolves
S="$CFG/settings.json"                 # the active profile's settings, not always ~/.claude
mkdir -p "$(dirname "$S")"             # a first-time custom-config profile may not have it yet
[ -f "$S" ] || echo '{}' > "$S"
jq --arg cmd "$CMD" '.statusLine = {type:"command", command:$cmd}' "$S" > "$S.tmp" && mv "$S.tmp" "$S"
```

If you edit the file with the Edit tool instead of `jq`, still change only the `statusLine` key and leave all other keys byte-for-byte intact.

## Step 4 — Verify

Pipe a minimal sample `StatusLineInput` into the exact command you wrote and confirm the output is non-empty.
Run this in one block with the same literal runner and target you used in Step 3 (shell vars don't survive from the earlier steps).
The sample is copy-paste deterministic — the `context_window.used_percentage` of 58 lands in the yellow tier, so line 1 always renders:

```bash
TSX="tsx"; TARGET="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline"   # match Step 3's resolved runner + target
echo '{"model":{"id":"claude-opus-4-8","display_name":"Opus 4.8"},"context_window":{"total_input_tokens":120000,"total_output_tokens":8000,"context_window_size":200000,"used_percentage":58,"remaining_percentage":42,"current_usage":null},"workspace":{"current_dir":"'"$HOME"'","project_dir":"'"$HOME"'","added_dirs":[]},"output_style":{"name":"default"},"effort":{"level":"high"}}' \
  | $TSX "$TARGET/statusline.ts"
```

Expect a line like `Opus 4.8 (high) | Context: 58% | <dir> (<branch>)`.
On macOS with a logged-in Claude Code a second usage line follows; elsewhere only the base line prints — both are success.
The script exits 0 even on usage failure, so treat **non-empty stdout** as the pass condition.
(Any `git` warning on stderr from a non-git `project_dir` is harmless and does not reach stdout.)

## Step 5 — Report

Tell the user:

- Where the bundle was installed and what `statusLine` command was written.
- That the change takes effect on the next Claude Code session (or after reloading settings).
- **Platform caveat:** the usage line (line 2) needs macOS plus a logged-in Claude Code, since it reads the OAuth credential from the Keychain.
  On other platforms, or before login, the base line (line 1) still renders and nothing errors.
