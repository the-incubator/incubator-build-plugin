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
| Mobile layout someday | spoken | defer | Explicit-deferral pre-check: "not for this round" is a scheduling decision the reviewer already made, so it routes to `defer` before the ordered tests run - without that pre-check this item is broad enough to satisfy `discuss` first |
| Date format "not a huge deal" | spoken | change (low priority) | Softener lowers priority within the bucket, never moves the bucket; flag as a candidate for user-move to `defer` |
| Annotation tool pin jumps on scroll | spoken | change (routed to tooling owner) | Meta-feedback: tagged normally, routed to the tooling repo, not the product work list |
| Empty state unreachable in demo | spoken | blocked (on the reachability check) | "Couldn't evaluate" is a pre-tag reachability check; with no product source it can't run, so the item is `blocked` on it - never invent a "build the empty state" requirement (step 6b) |
| "Recipes Recipes" duplicate label | written | change | Written pins are first-class |
| Recipe card wider "just a thought" | written | try | Suggestion, not a spec |
| Locked meal plan - intentional? | written | blocked (on confirming the gating decision) | The reviewer only *assumes* the lock is deliberate and asks for confirmation - producing the rationale requires checking the product/prior decisions, which this fixture ships no source for. Same rule as the other two: an unrunnable verification is `blocked`, not `respond`. It becomes `respond` the moment someone confirms |

Pass criteria for a run:

1. All 14 items captured (11 spoken + 3 written); none dropped, none merged away.
2. Buckets match the table (where the expected bucket is conditional, the run must show the verification/check attempt, not a silent pick).
3. All three verification-dependent items (header-height memory, empty state, locked meal plan) land in `blocked` with the unrunnable verification named as the missing input - none of them in `change` or `respond`. A run that invents a "build the empty state" requirement, or that answers the gating question without confirming it, fails this criterion.
4. Softener and meta-feedback items keep their bucket; the softener is flagged as a defer candidate, the tooling item is routed to the tooling owner.
5. The table is presented for approval before anything executes; approved tags persist as `triage.md`.
6. After approval, report.html cards carry bucket badges; the `respond` cards carry answers inline.
