---
name: inc:review-3a
description: Code review a pull request, or the uncommitted changes in the working tree if no PR is provided
allowed-tools: Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr comment:*), Bash(gh pr diff:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(git diff:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git blame:*)
disable-model-invocation: false
---

Provide a code review for the given pull request, or for the uncommitted changes in the working tree when no PR is provided.

## Mode detection

- **PR mode** — A PR number or GitHub PR URL is in `$ARGUMENTS`. Run all 8 steps below.
- **Local mode** — `$ARGUMENTS` is empty. The review target is uncommitted changes in the working tree (`git diff HEAD` plus `git diff --cached`). Skip steps 1 and 7 (no PR to gate on). In step 8, do not post to GitHub — print the formatted findings to the terminal instead. Code links in step 8 still require a full sha (use `git rev-parse HEAD`) and the resolved repo slug from `git remote get-url origin` if one exists; if not, render bare `path:Lstart-Lend` references instead of GitHub URLs.
- **No-changes guard (local mode only)** — If `git status --porcelain` is empty, stop with `No uncommitted changes to review.` and do not proceed.

In every step below, "the diff" means `gh pr diff <PR>` in PR mode and `git diff HEAD` (combined with staged changes) in local mode. "The pull request" means the PR in PR mode and "the local change set" in local mode — adapt agent prompts accordingly.

To do this, follow these steps precisely:

1. **PR mode only.** Use a Haiku agent to check if the pull request (a) is closed, (b) is a draft, (c) does not need a code review (eg. because it is an automated pull request, or is very simple and obviously ok), or (d) already has a code review from you from earlier. If so, do not proceed. **Skip in local mode.**
2. Use another Haiku agent to give you a list of file paths to (but not the contents of) any relevant CLAUDE.md files from the codebase: the root CLAUDE.md file (if one exists), as well as any CLAUDE.md files in the directories whose files the pull request (or local change set) modified
3. Use a Haiku agent to view the change and return a summary. In PR mode, the agent reads PR title, body, and `gh pr diff`. In local mode, the agent reads `git status --porcelain` and `git diff HEAD` (plus staged) to summarize the working-tree changes.
4. Then, launch 6 parallel Sonnet agents to independently code review the change. The agents should do the following, then return a list of issues and the reason each issue was flagged (eg. CLAUDE.md adherence, bug, historical git context, etc.):
   a. Agent #1: Audit the changes to make sure they comply with the CLAUDE.md. Note that CLAUDE.md is guidance for Claude as it writes code, so not all instructions will be applicable during code review.
   b. Agent #2: Read the file changes in the pull request, then do a shallow scan for obvious bugs. Avoid reading extra context beyond the changes, focusing just on the changes themselves. Focus on large bugs, and avoid small issues and nitpicks. Ignore likely false positives.
   c. Agent #3: Read the git blame and history of the code modified, to identify any bugs in light of that historical context
   d. Agent #4: Read previous pull requests that touched these files, and check for any comments on those pull requests that may also apply to the current pull request (or, in local mode, to the current working-tree changes).
   e. Agent #5: Read code comments in the modified files, and make sure the changes in the pull request comply with any guidance in the comments.
   f. Agent #6: Dispatch the `inc-architecture-strategist` subagent (defined at `agents/review/inc-architecture-strategist.agent.md`) to review the change from a system architecture perspective. The agent should surface architectural pattern violations, SOLID principle breaches, coupling/cohesion problems, circular dependencies, component boundary violations, leaky abstractions, API contract/interface stability issues, and inconsistent architectural patterns. Pass it the PR summary from step 3 and the diff so it can render its structured analysis (Architecture Overview, Change Assessment, Compliance Check, Risk Analysis, Recommendations) along with concrete issues.
5. For each issue found in #4, launch a parallel Haiku agent that takes the PR, issue description, and list of CLAUDE.md files (from step 2), and returns a score to indicate the agent's level of confidence for whether the issue is real or false positive. To do that, the agent should score each issue on a scale from 0-100, indicating its level of confidence. For issues that were flagged due to CLAUDE.md instructions, the agent should double check that the CLAUDE.md actually calls out that issue specifically. The scale is (give this rubric to the agent verbatim):
   a. 0: Not confident at all. This is a false positive that doesn't stand up to light scrutiny, or is a pre-existing issue.
   b. 25: Somewhat confident. This might be a real issue, but may also be a false positive. The agent wasn't able to verify that it's a real issue. If the issue is stylistic, it is one that was not explicitly called out in the relevant CLAUDE.md.
   c. 50: Moderately confident. The agent was able to verify this is a real issue, but it might be a nitpick or not happen very often in practice. Relative to the rest of the PR, it's not very important.
   d. 75: Highly confident. The agent double checked the issue, and verified that it is very likely it is a real issue that will be hit in practice. The existing approach in the PR is insufficient. The issue is very important and will directly impact the code's functionality, or it is an issue that is directly mentioned in the relevant CLAUDE.md.
   e. 100: Absolutely certain. The agent double checked the issue, and confirmed that it is definitely a real issue, that will happen frequently in practice. The evidence directly confirms this.
6. Filter out any issues with a score less than 80. If there are no issues that meet this criteria, do not proceed.
7. **PR mode only.** Use a Haiku agent to repeat the eligibility check from #1, to make sure that the pull request is still eligible for code review. **Skip in local mode.**
8. Finally, deliver the result. When writing the output, keep in mind to:
   a. Keep your output brief
   b. Avoid emojis
   c. Link and cite relevant code, files, and URLs

   **PR mode:** Use the `gh` bash command to comment back on the pull request with the result.

   **Local mode:** Print the same formatted block directly to the terminal — do not call `gh pr comment` and do not post anywhere. For code citations: if `git remote get-url origin` resolves to a GitHub URL, render full GitHub permalinks using `git rev-parse HEAD` for the sha. If origin does not resolve to a GitHub URL, render bare `path:Lstart-Lend` references instead of GitHub URLs. Cite uncommitted lines by their post-edit line numbers in the working tree.

Examples of false positives, for steps 4 and 5:

- Pre-existing issues
- Something that looks like a bug but is not actually a bug
- Pedantic nitpicks that a senior engineer wouldn't call out
- Issues that a linter, typechecker, or compiler would catch (eg. missing or incorrect imports, type errors, broken tests, formatting issues, pedantic style issues like newlines). No need to run these build steps yourself -- it is safe to assume that they will be run separately as part of CI.
- General code quality issues (eg. lack of test coverage, general security issues, poor documentation), unless explicitly required in CLAUDE.md
- Issues that are called out in CLAUDE.md, but explicitly silenced in the code (eg. due to a lint ignore comment)
- Changes in functionality that are likely intentional or are directly related to the broader change
- Real issues, but on lines that the user did not modify in their pull request

Notes:

- Do not check build signal or attempt to build or typecheck the app. These will run separately, and are not relevant to your code review.
- Use `gh` to interact with Github (eg. to fetch a pull request, or to create inline comments), rather than web fetch
- Make a todo list first
- You must cite and link each bug (eg. if referring to a CLAUDE.md, you must link it)
- For your final comment (PR mode) or terminal output (local mode), follow the following format precisely (assuming for this example that you found 3 issues). In local mode, omit the trailing `<sub>...</sub>` reaction footer — there's nothing to react to.

---

### Code review

Found 3 issues:

1. <brief description of bug> (CLAUDE.md says "<...>")

<link to file and line with full sha1 + line range for context, note that you MUST provide the full sha and not use bash here, eg. https://github.com/anthropics/claude-code/blob/1d54823877c4de72b2316a64032a54afc404e619/README.md#L13-L17>

2. <brief description of bug> (some/other/CLAUDE.md says "<...>")

<link to file and line with full sha1 + line range for context>

3. <brief description of bug> (bug due to <file and code snippet>)

<link to file and line with full sha1 + line range for context>

🤖 Generated with [Claude Code](https://claude.ai/code)

<sub>- If this code review was useful, please react with 👍. Otherwise, react with 👎.</sub>

---

- Or, if you found no issues:

---

### Code review

No issues found. Checked for bugs and CLAUDE.md compliance.

🤖 Generated with [Claude Code](https://claude.ai/code)

- When linking to code, follow the following format precisely, otherwise the Markdown preview won't render correctly: https://github.com/anthropics/claude-cli-internal/blob/c21d3c10bc8e898b7ac1a2d745bdc9bc4e423afe/package.json#L10-L15
  - Requires full git sha
  - You must provide the full sha. Commands like `https://github.com/owner/repo/blob/$(git rev-parse HEAD)/foo/bar` will not work, since your comment will be directly rendered in Markdown.
  - Repo name must match the repo you're code reviewing
  - # sign after the file name
  - Line range format is L[start]-L[end]
  - Provide at least 1 line of context before and after, centered on the line you are commenting about (eg. if you are commenting about lines 5-6, you should link to `L4-7`)
