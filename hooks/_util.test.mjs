// Tests for the event sanitizer's line-change extraction.
// Run: node --test hooks/_util.test.mjs
//
// The privacy contract is the point: sanitize() may emit line COUNTS
// (lines_added / lines_removed) off an Edit/Write/MultiEdit tool_response, but
// never diff text, file paths, or content. Counts are optional — absent when
// the response carries no usable counts, and never blocking the event.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize, lineCountsFromResponse } from "./_util.mjs";

const SALT = "test-salt";

// A structuredPatch hunk as Claude Code emits it: "+"/"-"/" " prefixed lines.
function hunk(lines) {
  return { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines };
}

test("lineCountsFromResponse tallies +/- from structuredPatch, ignores context", () => {
  const r = {
    structuredPatch: [
      hunk(["-old one", "+new one", "+new two", " context stays"]),
      hunk(["-gone", "+added"]),
    ],
  };
  assert.deepEqual(lineCountsFromResponse(r), { added: 3, removed: 2 });
});

test("lineCountsFromResponse prefers direct numeric fields when present", () => {
  const r = { lines_added: 5, lines_removed: 2, structuredPatch: [hunk(["+x"])] };
  assert.deepEqual(lineCountsFromResponse(r), { added: 5, removed: 2 });
});

test("lineCountsFromResponse keeps a lone direct field absent, never invents 0", () => {
  // "absent stays absent" — only lines_added was supplied, so lines_removed
  // must stay null, not become a fabricated 0.
  assert.deepEqual(lineCountsFromResponse({ lines_added: 4 }), { added: 4, removed: null });
  assert.deepEqual(lineCountsFromResponse({ lines_removed: 2 }), { added: null, removed: 2 });
});

test("lineCountsFromResponse counts a created file's content as additions", () => {
  // Write of a new file: create shape carries `content`, no structuredPatch.
  assert.deepEqual(
    lineCountsFromResponse({ type: "create", content: "one\ntwo\nthree\n" }),
    { added: 3, removed: 0 },
  );
  // No trailing newline counts the same.
  assert.deepEqual(
    lineCountsFromResponse({ type: "create", content: "a\nb" }),
    { added: 2, removed: 0 },
  );
  // Empty new file → zero additions, still a real count.
  assert.deepEqual(
    lineCountsFromResponse({ type: "create", content: "" }),
    { added: 0, removed: 0 },
  );
  // A non-create response with content but no patch stays unusable.
  assert.equal(lineCountsFromResponse({ type: "update", content: "a\nb" }), null);
});

test("lineCountsFromResponse returns null when there is nothing to count", () => {
  assert.equal(lineCountsFromResponse({}), null);
  assert.equal(lineCountsFromResponse({ structuredPatch: [] }), null);
  assert.equal(lineCountsFromResponse({ structuredPatch: "nope" }), null);
  assert.equal(lineCountsFromResponse(null), null);
  assert.equal(lineCountsFromResponse("string"), null);
});

test("lineCountsFromResponse rejects negative / non-integer direct fields, falls back", () => {
  // Bad direct fields must not win; fall through to the patch.
  const r = { lines_added: -3, lines_removed: 1.5, structuredPatch: [hunk(["+a", "-b"])] };
  assert.deepEqual(lineCountsFromResponse(r), { added: 1, removed: 1 });
});

test("sanitize emits line counts for an Edit PostToolUse", () => {
  const out = sanitize("PostToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: "/repo/src/index.ts" },
    tool_response: { structuredPatch: [hunk(["-a", "+b", "+c"])] },
  }, SALT);
  assert.equal(out.lines_added, 2);
  assert.equal(out.lines_removed, 1);
  // Still only the extension, never the path.
  assert.equal(out.file_ext, ".ts");
});

test("sanitize emits line counts for Write and MultiEdit", () => {
  const write = sanitize("PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: "/repo/new.md" },
    tool_response: { structuredPatch: [hunk(["+one", "+two", "+three"])] },
  }, SALT);
  assert.equal(write.lines_added, 3);
  assert.equal(write.lines_removed, 0);

  const multi = sanitize("PostToolUse", {
    tool_name: "MultiEdit",
    tool_input: { file_path: "/repo/a.js" },
    tool_response: { lines_added: 10, lines_removed: 4 },
  }, SALT);
  assert.equal(multi.lines_added, 10);
  assert.equal(multi.lines_removed, 4);
});

test("sanitize emits only the present field for a lone direct count", () => {
  const out = sanitize("PostToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: "/repo/x.ts" },
    tool_response: { lines_added: 7 },
  }, SALT);
  assert.equal(out.lines_added, 7);
  assert.equal("lines_removed" in out, false);
});

test("sanitize counts a new-file Write with no structuredPatch", () => {
  const out = sanitize("PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: "/repo/brand-new.ts" },
    tool_response: { type: "create", content: "export const a = 1;\nexport const b = 2;\n" },
  }, SALT);
  assert.equal(out.lines_added, 2);
  assert.equal(out.lines_removed, 0);
});

test("sanitize omits line counts when the response carries none (absent stays absent)", () => {
  const out = sanitize("PostToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: "/repo/x.ts" },
    tool_response: { userModified: false },
  }, SALT);
  assert.equal("lines_added" in out, false);
  assert.equal("lines_removed" in out, false);
});

test("sanitize never adds line counts for non-edit tools", () => {
  const read = sanitize("PostToolUse", {
    tool_name: "Read",
    tool_input: { file_path: "/repo/x.ts" },
    tool_response: { structuredPatch: [hunk(["+a"])] },
  }, SALT);
  assert.equal("lines_added" in read, false);
  assert.equal("lines_removed" in read, false);
});

test("sanitize leaks no content — only whitelisted count/identity keys survive", () => {
  const out = sanitize("PostToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: "/secret/passwords.txt", old_string: "hunter2", new_string: "hunter3" },
    tool_response: {
      structuredPatch: [hunk(["-hunter2", "+hunter3"])],
      originalFile: "hunter2\nmore secrets",
    },
  }, SALT);
  const allowed = new Set([
    "event_name", "occurred_at", "tool_name", "file_ext",
    "lines_added", "lines_removed", "project_id_hash",
  ]);
  for (const key of Object.keys(out)) {
    assert.ok(allowed.has(key), `unexpected key leaked: ${key}`);
  }
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes("hunter"), false, "content must never appear");
  assert.equal(serialized.includes("passwords"), false, "path must never appear");
});

test("a zero-change edit still emits explicit zero counts, not omission", () => {
  // structuredPatch present but only context lines → counts are a real 0/0.
  const out = sanitize("PostToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: "/repo/x.ts" },
    tool_response: { structuredPatch: [hunk([" unchanged", " also unchanged"])] },
  }, SALT);
  assert.equal(out.lines_added, 0);
  assert.equal(out.lines_removed, 0);
});
