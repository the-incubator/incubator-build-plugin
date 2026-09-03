# Upload and Approval

Upload a temporary preview for the user to review, then deliver the approved evidence to the caller.

**Two delivery modes.** The caller chooses where the evidence ultimately lives (see the "Delivery mode" argument in `SKILL.md`):

- **`github-attachment`** — the caller (e.g. `inc:commit-push-pr-4`) will upload the file into the PR body itself via `gh --attach` (GitHub CLI **2.99.0+**). No third-party host is involved. demo-reel returns the **local artifact path(s)** and leaves the files in place for the caller to attach.
- **`hosted`** (default) — demo-reel promotes the approved file to a permanent public host (catbox) and returns that URL. This is the behavior for callers that cannot attach to a PR body.

The preview upload and approval gate below are identical for both modes — they happen before any PR exists and are the right review step regardless of final destination.

## Step 1: Preview Upload (Temporary)

Upload the evidence file (GIF or PNG) to litterbox for a temporary 1-hour preview:

```bash
python3 "<plugin root>/skills/demo-reel/scripts/capture-demo.py" preview [ARTIFACT_PATH]
```

The last line of output is the preview URL (e.g., `https://litter.catbox.moe/abc123.gif`). This URL expires after 1 hour — no cleanup needed.

For multiple files (static screenshots tier), upload each file separately.

**If upload fails** after retry, fall back to opening the local file with the platform file-opener (`open` on macOS, `xdg-open` on Linux) so the user can still review it. Include the local path in the approval question instead of a URL.

## Step 2: Approval Gate

Present the preview URL to the user for approval. Use the platform's blocking question tool (`AskUserQuestion` in Claude Code, `request_user_input` in Codex, `ask_user` in Gemini).

**Question:** "Evidence preview (1h link): [PREVIEW_URL]"

**Options:**
1. **Use this in the PR** -- deliver per the active delivery mode
2. **Recapture** -- provide instructions on what to change
3. **Proceed without evidence** -- set evidence to null and proceed

If the question tool is unavailable (headless/background mode), present the numbered options and wait for the user's reply before proceeding.

### On "Recapture"

Return to the tier execution step. The user's instructions guide what to change in the next capture attempt. After recapture, upload a new preview and repeat the approval gate.

### On "Proceed without evidence"

Set evidence to null and proceed. The preview link expires on its own.

## Step 3: Deliver the Approved Evidence

Branch on the delivery mode.

### Mode `github-attachment` — return local paths, skip third-party hosting

Do **not** promote to catbox. The caller uploads the file straight into the PR body via `gh --attach`, so a third-party host would be a pointless extra copy. Keep the artifact where it is and return its absolute local path.

Resolve the absolute path so the caller can pass it to `gh --attach` from any working directory:

```bash
python3 -c "import os,sys; print(os.path.abspath(sys.argv[1]))" [ARTIFACT_PATH]
```

For multiple files, resolve each. Skip Step 5 cleanup for these files (see below).

### Mode `hosted` — promote to permanent hosting

After the user approves, upload to permanent catbox hosting. The command accepts either the preview URL (preferred) or the local file path (fallback):

```bash
python3 "<plugin root>/skills/demo-reel/scripts/capture-demo.py" upload [PREVIEW_URL or ARTIFACT_PATH]
```

If Step 1 produced a preview URL, pass it here -- catbox copies directly from litterbox without re-uploading. If Step 1 fell back to local review (no preview URL), pass the local artifact path instead.

The last line of output is the permanent URL (e.g., `https://files.catbox.moe/abc123.gif`). Use this URL in the output, not the preview URL.

For multiple files, promote each separately.

## Step 4: Return Output

Return the structured output defined in the `SKILL.md` Output section: `Tier`, `Delivery`, `Description`, and then either `Path` (for `github-attachment` mode — local absolute path(s)) or `URL` (for `hosted` mode — permanent catbox URL(s)). The caller formats the evidence into the PR description. demo-reel does not generate markdown.

## Step 5: Cleanup

- **Mode `hosted`:** remove the `[RUN_DIR]` scratch directory and all temporary files. Preserve nothing -- the evidence lives at the permanent URL now.
- **Mode `github-attachment`:** do **not** delete the returned artifact(s) — the caller still needs them to run `gh --attach`, and deleting first would leave the PR with a broken local reference. Leave the artifacts in place and report their paths in the output. The caller owns removal once the attachment has been uploaded and verified. You may delete any *other* scratch files that are not part of the returned artifact set.
