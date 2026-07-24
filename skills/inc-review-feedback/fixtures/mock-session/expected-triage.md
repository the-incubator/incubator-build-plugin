# Answer key — expected triage for the mock session

Grader's reference for regression-testing the skill's triage output.
Item wording may differ run to run; what must match is the bucket (and the flagged rules).
The mock has 11 spoken items (notes.md) plus 3 written pins (annotations.json).

| Item (short) | Source | Expected bucket | Rule being exercised |
|---|---|---|---|
| Swap Save/Cancel buttons | spoken | change | Unambiguous, any engineer builds the same thing |
| Header height "used to be smaller" | spoken | change *or* respond - only after verification | Tentative memory is a pre-tag verification, never straight to `change`; unverifiable without the product repo → stays flagged unverified |
| Two filter icons confusing | spoken | try | Goal agreed, means unspecified; building one option beats discussing |
| Recipe grid "feels off / cramped" | spoken | discuss | Felt reaction, no direction, main surface = high rework cost |
| Export button always visible | spoken | respond *if* a prior deliberate decision is found, else try | The pre-ordered check: prior-decision conflict routes to `respond` before the size of the change is considered |
| Settings page - found it | spoken | respond | Reviewer self-resolved; answer confirms, no code |
| Brand icon swap awaiting Priya's pack | spoken | blocked | Agreed + trivial once the asset exists; named owner |
| Mobile layout someday | spoken | defer | Stated future intent, explains the grid comments, not in scope |
| Date format "not a huge deal" | spoken | change (low priority) | Softener lowers priority within the bucket, never moves the bucket; flag as a candidate for user-move to `defer` |
| Annotation tool pin jumps on scroll | spoken | change (routed to tooling owner) | Meta-feedback: tagged normally, routed to the tooling repo, not the product work list |
| Empty state unreachable in demo | spoken | caveat → resolve first | "Couldn't evaluate" is a pre-tag reachability check, not a bucket; unresolved without the product repo |
| "Recipes Recipes" duplicate label | written | change | Written pins are first-class |
| Recipe card wider "just a thought" | written | try | Suggestion, not a spec |
| Locked meal plan - intentional? | written | respond | Reviewer guessed gating; confirm with rationale |

Pass criteria for a run:

1. All 14 items captured (11 spoken + 3 written); none dropped, none merged away.
2. Buckets match the table (where the expected bucket is conditional, the run must show the verification/check attempt, not a silent pick).
3. The tentative-memory and empty-state items are NOT tagged `change` without a verification step (this fixture repo has no product source, so both should end flagged unverified/unresolved).
4. Softener and meta-feedback items keep their bucket; the softener is flagged as a defer candidate, the tooling item is routed to the tooling owner.
5. The table is presented for approval before anything executes; approved tags persist as `triage.md`.
6. After approval, report.html cards carry bucket badges; the `respond` cards carry answers inline.
