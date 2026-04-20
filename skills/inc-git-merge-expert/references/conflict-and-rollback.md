# Conflict And Rollback Playbook

Use this reference when resolving conflicts, regenerating artifacts, or recovering from a bad merge.

## Conflict Tiers

### Tier 1: Mechanical

- whitespace-only differences
- import ordering
- generated files
- lockfiles

Prefer regeneration over manual editing for generated artifacts and lockfiles.

### Tier 2: Semantic

- both sides changed real logic
- shared functions or signatures changed
- call-site behavior changed

Read both sides fully and merge intent rather than picking a winner blindly.

### Tier 3: Escalate Or Recover

Use this when:

- the conflict reflects an architectural disagreement
- domain knowledge is missing
- the merge state is easier to redo than repair

At that point:

- abort or revert safely
- or route to the worktree specialist for isolated retry

## Lockfile Handling

When lockfiles conflict:

- do not hand-edit them
- regenerate them with the package manager
- re-add the regenerated file

## Rollback Rules

- prefer `git revert` on shared branches
- use `git reset` only with clear safety and explicit approval
- create a backup tag before destructive recovery
- verify the recovered state with status and relevant validation commands

## Cleanup Rules

- delete merged branches only when confirmed merged or explicitly requested
- do not force-push shared branches without explicit approval
- keep the user informed about any destructive cleanup step
