---
name: inc-principle-invert-the-test-pyramid
description: "Use only when explicitly asked to choose a test strategy by inverting the test pyramid. Start with e2e, black-box, golden-master, or integration coverage at the outermost observable boundary; add lower-level tests when outer coverage cannot isolate or economically cover a defect."
disable-model-invocation: true
---

# Invert the test pyramid

Start at the outermost observable boundary that exercises the behavior: e2e, black-box HTTP/browser/CLI, golden-master, or integration coverage.
Prefer a test that can catch a defect in the working system over a collection of model-written unit tests that adds lines without catching defects.
Choose the narrowest lower level only when an outer test cannot isolate or economically cover the defect.
This is an opinionated default for choosing test levels, not a law against unit tests.

## When to move inward

Add a lower-level test when:

- Combinatorial logic has too many branches to cover economically through the outer boundary.
- A pure function has tricky edge cases that are clearer and more complete when exercised directly.
- An outer test detects a defect but cannot localize the failing rule well enough to guide a fix.
- Performance-sensitive inner loops need focused measurements or regression checks.
- An error path is impractical to induce end to end.

Keep the outer test for the user-visible contract when it remains reliable and useful.
Use the focused test to cover the specific gap, not to mirror every implementation step.

## When the default does not fit

For a library or SDK, the public API may itself be the unit, so direct API tests can be the outer boundary.
For a heavily algorithmic core, focused tests may carry most of the meaningful coverage.
If e2e infrastructure is too slow or flaky to run reliably, choose a dependable boundary closer to the code and improve that infrastructure separately.

`inc-principle-test-behavior-not-implementation` governs how every test is written, whatever its level.
This skill governs which level to reach for first.
When reviewing a test strategy, `inc-review-deep` and its `inc-testing-reviewer` persona can check whether the chosen levels cover real defects without duplicating coverage for its own sake.
