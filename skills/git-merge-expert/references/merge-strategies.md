# Merge Strategies

Use this reference when choosing how to merge and whether to route the task to the worktree specialist.

## Readiness Checks

Before merging, inspect:

- current working tree cleanliness
- source vs target branch topology
- PR CI status
- PR review status
- mergeability or conflict risk

## Strategy Selection

Common strategies:

- fast-forward when the target can advance cleanly
- merge commit when an explicit merge point is valuable
- squash when the project prefers cleaner mainline history
- rebase when the project expects linear history

Pick the smallest strategy that matches project conventions and the user's request.

## GitHub CLI Usage

Useful commands:

- `gh pr view <n>`
- `gh pr checks <n>`
- `gh pr merge <n> --squash`
- `gh pr merge <n> --merge`
- `gh pr merge <n> --rebase`
- `gh pr comment <n> --body "..."`

Prefer `gh pr merge` for PR-based workflows when it matches repo conventions.

## When To Route To The Worktree Specialist

Prefer `git-merge-expert-worktree` when:

- the user explicitly asks for worktree isolation
- the merge is risky or likely conflict-heavy
- the repo needs disposable isolation for retry safety
- branch cleanup and validation are easier in a separate workspace

Inline execution is fine for straightforward, low-risk merges with a clean working tree.
