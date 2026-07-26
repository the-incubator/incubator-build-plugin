# Answer key — expected triage for the mock session

Grader's reference for regression-testing the skill's triage output.
Item wording may differ run to run; what must match is the bucket (and the flagged rules).
The mock has 11 spoken items (notes.md) plus 3 written pins (annotations.json).

| Item (short) | Source | Expected bucket | Rule being exercised |
|---|---|---|---|
| Swap Save/Cancel buttons | spoken | change | Unambiguous, any engineer builds the same thing |
| Header height "used to be smaller" | spoken | blocked (on the git-history check) | Tentative memory is a pre-tag verification, never straight to `change`; this fixture ships no product source, so the check can't run and the item is `blocked` on it with a named owner |
| Two filter icons confusing | spoken | try | Goal agreed, means unspecified; building one option beats discussing |
| Recipe grid "feels off / cramped" | spoken | discuss | Felt reaction, no direction, main surface = high rework cost |
| Export button always visible | spoken | change | The reviewer named the destination (overflow menu), so the `change` test passes; it would route to `respond` instead if a prior deliberate decision about toolbar prominence were found, which is the pre-ordered check |
| Settings page - found it | spoken | respond | Reviewer self-resolved; answer confirms, no code |
| Brand icon swap awaiting Priya's pack | spoken | blocked | Agreed + trivial once the asset exists; named owner |
| Mobile layout someday | spoken | defer | Stated future intent, explains the grid comments, not in scope |
| Date format "not a huge deal" | spoken | change (low priority) | Softener lowers priority within the bucket, never moves the bucket; flag as a candidate for user-move to `defer` |
| Annotation tool pin jumps on scroll | spoken | change (routed to tooling owner) | Meta-feedback: tagged normally, routed to the tooling repo, not the product work list |
| Empty state unreachable in demo | spoken | blocked (on the reachability check) | "Couldn't evaluate" is a pre-tag reachability check; with no product source it can't run, so the item is `blocked` on it - never invent a "build the empty state" requirement (step 6b) |
| "Recipes Recipes" duplicate label | written | change | Written pins are first-class |
| Recipe card wider "just a thought" | written | try | Suggestion, not a spec |
| Locked meal plan - intentional? | written | respond | Reviewer guessed gating; confirm with rationale |

Pass criteria for a run:

1. All 14 items captured (11 spoken + 3 written); none dropped, none merged away.
2. Buckets match the table (where the expected bucket is conditional, the run must show the verification/check attempt, not a silent pick).
3. The tentative-memory and empty-state items are NOT tagged `change`; both land in `blocked` with the unrunnable verification named as the missing input. A run that invents a "build the empty state" requirement fails this criterion.
4. Softener and meta-feedback items keep their bucket; the softener is flagged as a defer candidate, the tooling item is routed to the tooling owner.
5. The table is presented for approval before anything executes; approved tags persist as `triage.md`.
6. After approval, report.html cards carry bucket badges; the `respond` cards carry answers inline.
