---
name: inc-principle-test-behavior-not-implementation
description: "Apply when you write, change, keep, or review a test. Call the subject the way its users do and assert the observable result against a literal expected value or an independently meaningful invariant. Weak tests (bare toBeDefined/toBeTruthy/not.toThrow/toBeInstanceOf/toBeUndefined, mock-only toHaveBeenCalled, empty spy history, self-referential expects, incidental constant pins, fixture-asserts-fixture) still pass when the subject is broken; rewrite the assertion or delete the test. Empty-collection matchers on a real return and black-box HTTP/browser/CLI/integration tests that import no subject are legitimate."
disable-model-invocation: false
---

# Test behavior, not implementation

A test calls the code the way its users do and asserts the result they observe against a literal expected value, or against an independently meaningful invariant.
A test that asserts which calls the code made, or restates a constant the code contains, does neither.

Apply this while writing or changing tests, and when keeping an existing test in a diff.
`inc-review-deep` and the always-on `inc-testing-reviewer` persona use the same bar: coverage that cannot fail for a defect is false confidence.

**Why:** A test that cannot fail for a defect costs CI time and review attention and catches nothing.
A constant pin also fails when someone edits the constant or the prompt it restates, so it prevents that edit.

## The check

Before you keep a test, pick the check that matches how the test reaches the application.

**The test imports a subject function.** Replace that subject with a no-op that immediately returns `undefined` (do not only change a void return while leaving the real body running).
Mutate the application entry point under test, not the test runner, `expect`/`assert`, or fixture helpers.
If the test would still pass, it observes no behavior and cannot fail for a defect.
Rewrite the assertion or delete the test.

**The test is black-box HTTP, browser, CLI, or integration coverage that invokes the application externally and imports no subject function.**
Do not apply the undefined-import check; it is vacuous when nothing under test is imported.
Judge the test by whether it asserts a literal observable response (status, body, screenshot, stdout, exit code, persisted state) and would fail for a real defect.

## Weak shapes (rewrite or delete)

These still pass when the subject is broken.
Keep only these as the weak list; do not treat a matcher as vacuous merely because it mentions emptiness or type.

- **Weak or no assertion.** No assertion at all (Jest `expect`, Node `assert`, Python `assert`, Go `testing` fatals, and the rest count; do not treat a missing `expect` as missing coverage), or only bare `toBeDefined`, `toBeTruthy`, `not.toThrow`, `toBeInstanceOf`, `toBeUndefined`, or `not.toBe(wrongValue)`.
- **Mock or absence only.** Only `toHaveBeenCalled`, `not.toHaveBeenCalled`, `toHaveBeenCalledTimes(0)`, or empty spy/mock history such as `expect(fn.mock.calls).toEqual([])`.
  Exception: keep a `toHaveBeenCalled` assertion when that call *is* the observable contract (a completion callback, a transport flush) and a no-op subject would fail it.
- **Self-referential.** The expected value comes from the code under test: `expect(f(a)).toBe(f(a))`, `expect(parsed.url).toBe(buildUrl(...))`.
- **Constant pin.** The assertion restates a hand-maintained incidental constant, config default, table row, or prompt string: `expect(LIMITS.maxTools).toBe(8)`, `expect(PROMPT).toContain("You are")`.
- **Fixture asserts fixture.** The assertion reads data the test built or a value computed in `beforeEach`, and the subject never runs. Calling the subject in `beforeEach` and asserting a literal property of that result in the body is not this shape.

## Legitimate tests this rule does not reject

Empty-collection assertions on the subject's actual return value are literal observable results.
`expect(fn(input)).toEqual([])` and `toHaveLength(0)` fail when the subject returns `undefined`.
Do not list them as weak.

The same holds for other matchers that pin a real return, such as `toBeGreaterThan(0)` when the contract is a positive count.
Bare `toBeUndefined` and `not.toBe(wrongValue)` still pass if the subject returns `undefined`; they stay weak.
For an absence contract, assert the missing case together with a present case on another input in the same test.

Black-box tests that never import the subject are not weak merely because the import-undefined heuristic would pass.
They are weak only when they fail the black-box check above (no literal observable assertion, or they would still pass for a real defect).

## The fix

Call the subject inside the test body with one concrete input and assert the literal output or the observable effect, `expect(slugify("Hello, World!")).toBe("hello-world")`.
For an absence, assert the presence on the other input in the same test.
For a constant, test the mechanism that reads it with one input instead of restating the value.
For a mock, assert the payload it received or the observable state after the call (no row written, no request sent), not that it was called.
When no such assertion exists, delete the test.

## Keep

Keep a test of a relation across a table's rows (a key present in two tables, a parent that exists), a compile-time check in a `*.test-d.ts` file, a property-based or metamorphic check that asserts an independently meaningful invariant (`decode(encode(value))` equals `value`), and an exact pin of a public compatibility contract (a wire-protocol tag, persisted schema identifier, or public API version).

Derived from an MIT-licensed upstream principle; see [NOTICE.md](NOTICE.md).
