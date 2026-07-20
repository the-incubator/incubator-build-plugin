# Feedback triage

Applies after synthesis on the extensive-analysis path: every synthesized requirement (with its verbatim evidence) gets exactly one **bucket** tag before anything is planned or implemented.
The bucket answers one question: **what is the next action for this item, and whose action is it?**
Then the full table is presented to the user for adjustment before anything executes.
Do not implement anything at this stage.

## The six buckets

Every item lands in exactly one bucket.
When torn between two, apply the membership tests in order - the first that passes wins.

### 1. `change` - make it, no discussion needed

The ask is unambiguous, verified, and small enough that any reasonable implementation is the right one.

- **Test:** could two different engineers implement this and produce essentially the same outcome?
- **Downstream:** straight to implementation; the closing report shows "done" with before/after.
- **Examples:** "the rank should be the first column"; "delete the duplicate column"; "revert the grid to 4 columns" (tentative reviewer memory, but git history confirmed it - verification promotes an item into `change`).

### 2. `try` - build one take, attach the open question

The goal is agreed but the means isn't specified, and building one defensible option is cheaper than discussing options in the abstract.
The tag carries an obligation: the report must state the approach chosen and the open question, not just show the diff.

- **Test:** is building one option cheaper than discussing options?
- **Downstream:** implement with a stated approach; report reads "here's what we tried - veto?"
- **Examples:** "the two undo arrows confuse me" (which remedy? - build labels + distinct icons, let the reviewer veto); "maybe a circle around the arrow" (a suggestion, not a spec).

### 3. `discuss` - talk before building

The cost of a wrong first take is high (big effort, wide blast radius, or the direction itself is unresolved), so building speculatively wastes more than a conversation costs.
This is the inverse of `try`.

- **Test:** if the first attempt were wrong, would the rework be expensive or the stakeholder annoyed?
- **Downstream:** no code - produce mocks, options, or a short brief; the report asks the question explicitly.
- **Example:** "something about the blue feels off" on a whole component - a felt reaction with no direction; restyling on a guess risks a full redo, so mock 2-3 directions instead.

### 4. `respond` - no change; an answer goes back instead

The correct outcome is information, not code: the ask conflicts with a deliberate prior decision, rests on a wrong assumption, or the reviewer already resolved it themselves.
Without this bucket these items get silently dropped (the reviewer concludes they were ignored) or wrongly implemented (a past decision gets overwritten because nobody remembered it).
This is the trust bucket.

- **Test:** would the stakeholder be satisfied by an explanation with no diff?
- **Downstream:** a written answer in the report; nothing in the codebase.
- **Examples:** items "blocked off" that the reviewer guessed were intentional gating (confirm it); an always-on column group that was an explicit product decision weeks earlier (answer with the rationale; changing it is a new conversation).

### 5. `blocked` - agreed, but waiting on a non-code input

Everyone agrees and the code change is often trivial, but it can't land without something outside the repo: an asset, data, access, a third party, another team's PR.
Not `change` (nothing implementable yet), not `defer` (it's wanted now).

- **Test:** if the missing input appeared today, would this instantly become a `change` item?
- **Downstream:** a tracked dependency with a named owner; report reads "waiting on X from Y."
- **Example:** icon consistency that needs logo art produced first - the swap is a few lines once assets exist.

### 6. `defer` - agreed, consciously not now

Real and valid, but deliberately scheduled for later: low priority, batches better with future work, or belongs to a future phase.
The key word is *consciously* - a defer is a decision with a pointer (backlog entry or issue), never a quiet drop.

- **Test:** would you say "yes, but not in this pass" without needing anyone else's input?
- **Downstream:** backlog entry; report reads "queued" so the stakeholder sees it registered.
- **Example:** future intent the reviewer mentioned to justify another ask ("the Superflex tab is coming") - it explains the other item, it isn't itself in scope.

## Rules that cut across buckets

- **Verification is a pre-tag step, not a bucket.** Resolve "couldn't evaluate" caveats and tentative recollections (reachability checks, git history, code reading) *before* tagging; a verified claim usually lands in `change` or `respond`. Never tag an unverified claim as `change`.
- Keep it to these six. Each maps to exactly one downstream action - that's what makes tagging operational rather than ceremonial. Resist adding a severity dimension; the buckets encode it implicitly.
- Reviewer-tone qualifiers ("not a huge deal", "if not possible, that's fine") lower priority *within* a bucket; they don't change the bucket. They're also candidates for the user to move to `defer` - flag them.
- Meta-feedback about the review tooling itself gets tagged like everything else but routed to the tooling's repo/owner, not the product's work list.

## Procedure

1. Verify anything tentative (see the pre-tag rule), then assign a bucket to every item.
2. Present one table: `ID · bucket · one-line summary`, grouped by bucket, with a one-line legend.
3. Explicitly flag the judgment calls - items where you weighed two buckets - and say which test decided it.
4. Ask the user for adjustments ("R16 → discuss" style). Apply them without debate; the user's tag wins.
5. Persist the final tags as `triage.md` in the analyzer output dir, next to `requirements-kickoff.md`: the approved table plus, for each non-`change` item, the one line its downstream action needs (the open question for `try`/`discuss`, the answer for `respond`, the dependency and owner for `blocked`, the backlog pointer for `defer`). The tags drive execution batching and the closing stakeholder report. Nothing executes until the user approves the table.

## Calibration example

From a real session reviewing a fantasy-sports draft tool:

| Bucket | Items |
|---|---|
| change | rank-first column, drop Team column, ADP scoping, duplicate-ADP collapse, hide Pos in position tabs, SoS side-by-side, dividers on all rows, CTA press parity, grid revert, annotation-tool dialog bug |
| try | column spacing "feels weird", filter-bar real estate, undo/clear disambiguation, chevron affordance, one-line rows, feedback-bar overlap |
| discuss | compare-matrix restyle ("the blue feels off"), app-wide text weight |
| respond | week-one gating (reviewer self-resolved), always-on positional group (prior explicit decision) |
| blocked | icon consistency ×2 (needs logo art; owner: reviewer) |
| defer | Superflex tab + scoring toggles (stated future intent) |
