# Collector Fetch

Pull a piece of feedback that a reviewer **submitted** through the preview annotation tool (it lives in the incubator collector app, not on disk), then hand it to the analyzer.

This is the missing link people trip over: the analyzer only reads local files, so feedback that was *submitted* has to be fetched first. The resolver below finds the right submission and downloads its recording (and annotations) locally.

## Resolve + fetch

```bash
node "<plugin root>/skills/inc-review-feedback/scripts/fetch_feedback.mjs" <query>
```

`<query>` is whatever the user gave you:

| User said | Pass |
|---|---|
| a link — `https://…/f/88240c83-…` (any URL ending in the id) | the URL verbatim |
| "get nick's feedback" / a reviewer name | `nick` (or the name) |
| "the feedback on my branch" / "review feedback" with no file | `--branch` (matches the current git branch → PR / project → preview) |
| a bare session id | the id |
| "what's waiting?" / browse | `--list` (prints a summarized list of recent submissions and stops) |

Useful flags: `--out <dir>` (where to download; defaults to a temp dir), `--include-open` (also consider un-submitted sessions), `--repo-dir <dir>` (branch mode against a specific repo checkout), `--limit <n>` (how many sessions to summarize, default 10), `--no-summary` (bare table, skips the per-session fetch).

The resolver shells out to the plugin's `inc-build.mjs` for the actual collector API calls, so org auth stays single-sourced there. If it prints an auth error, the fix is the same as any `inc-build` call (org credentials at `~/.claude/incubator/credentials.json`).

## Read the output, then continue

The resolver prints machine-readable lines on stdout:

- `RESOLVED_SESSION=<id>` — which submission it picked.
- `RESOLVED_ZIP=<path>` — the downloaded riffrec bundle. **Feed this straight into the analyzer** (`analyze_riffrec_zip.py`), then route to the quick or extensive path by recording length / issue count, exactly as for a local zip.
- `RESOLVED_ANNOTATIONS=<path>` — printed **instead of** `RESOLVED_ZIP` when the submission has no recording. There is nothing to transcribe: read the annotations JSON and summarize the click-to-comment feedback directly (each entry has `comment`, `pageUrl`, `element`, `elementPath`, `cssClasses`). Do not force it through the analyzer.

Exit codes:

- `0` — resolved and fetched. Parse the lines above and continue.
- `1` — no match. Show the user what you searched and offer `--list`, a link, or a reviewer name.
- `2` - **more than one match**. The candidates were printed to stderr as a summarized list (see below). Show them to the user and ask which session id to use, then re-run with that id. Do not guess.
- `3` — usage / auth / transport error. Surface the message.

## The summarized list

`--list` and exit code `2` both print the same block per candidate, best first:

```
  [2] 14ff84cd-2a5d-4676-a124-4bd096614c47
      Drew · tenfold-www-preview · submitted · 2026-07-25 02:27Z (33h ago)
      16 comments, no recording · /
      · I think we should take out the small text entirely and possible make the text bigger. I…
      · Interactive Exspiereinces that you can track
      · …and 13 more
```

The sessions endpoint carries no comment text or count, so each summarized session costs one extra `feedback get` call - that's what `--limit` caps and what `--no-summary` turns off.
A session whose detail fetch fails still lists, marked `contents unavailable`.

**Always relay this list to the user and let them choose.**
Repeat submissions from one reviewer are separate rounds, not duplicates - picking the newest and stopping silently loses a whole round of feedback.
Process the chosen ones one at a time, oldest first, and name the round in each artifact.

## Notes

- A submission with both a recording **and** annotations downloads both; prefer the recording for analysis and fold the annotation comments in as extra evidence (they carry precise element/CSS context the voice track lacks).
- Empty, un-submitted sessions (someone opened the tool but left nothing) are filtered out by default — pass `--include-open` only if you specifically want them.
- Branch mode is heuristic: it maps the current branch to a PR number (`gh pr view`) and/or the repo name to a project slug, then matches those against each session's `pageUrl` / `previewKey`. If it can't map the branch, it says so and falls back to asking for a link or name.
