// Checks that the IncPad toolbox block snippets agents copy from the inc-pad skill
// follow the blocks runtime contract the web app renders: <incpad-callstack> rows with
// data-mark/data-depth/data-at, and <incpad-code> slices with in-range <incpad-pin>s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = join(resolve(fileURLToPath(import.meta.url), "..", ".."), "skills", "inc-pad");
const catalog = readFileSync(join(SKILL_DIR, "references", "blocks.md"), "utf8");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

const MARKS = new Set(["+", "~", "-", "?"]);
const PIN_KINDS = new Set(["info", "warn", "risk", "ok"]);

function htmlFences(markdown) {
  return [...markdown.matchAll(/```html\n([\s\S]*?)```/g)].map((m) => m[1]);
}

function attrs(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

function blocks(name) {
  const re = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`, "g");
  return htmlFences(catalog).flatMap((html) =>
    [...html.matchAll(re)].map((m) => ({ attrs: attrs(m[1]), body: m[2] })),
  );
}

// Parse a code block the way the contract defines it: raw text with <incpad-pin> children.
function parseCode(body) {
  const pins = [...body.matchAll(/<incpad-pin\b([^>]*)>([\s\S]*?)<\/incpad-pin>/g)].map((m) => ({
    attrs: attrs(m[1]),
    text: m[2].trim(),
  }));
  const code = body.replace(/<incpad-pin\b[\s\S]*?<\/incpad-pin>/g, "").replace(/\s+$/, "");
  return { pins, lines: code.split("\n") };
}

test("the skill lists both toolbox blocks and links the catalog", () => {
  assert.match(skill, /\(references\/blocks\.md\)/);
  assert.match(skill, /<incpad-callstack>/);
  assert.match(skill, /<incpad-code /);
});

test("the catalog names the injected runtime paths", () => {
  assert.match(catalog, /`\/pad-editor\/blocks\.js`/);
  assert.match(catalog, /`\/pad-editor\/blocks\.css`/);
  for (const html of htmlFences(catalog)) {
    assert.doesNotMatch(html, /<script|<link/, "snippets must rely on the injected runtime");
  }
});

test("every call stack snippet has an id and contract-valid rows", () => {
  const stacks = blocks("incpad-callstack");
  assert.ok(stacks.length > 0, "catalog has a call stack snippet");
  for (const stack of stacks) {
    assert.ok(stack.attrs.id, "call stack has a stable id");
    const rows = [...stack.body.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)];
    assert.ok(rows.length > 0, "call stack has rows");
    let previousDepth = -1;
    for (const [, rawAttrs, text] of rows) {
      const row = attrs(rawAttrs);
      assert.ok(MARKS.has(row["data-mark"]), `mark ${row["data-mark"]} is one of + ~ - ?`);
      assert.match(row["data-depth"], /^\d+$/, "depth is a non-negative integer");
      const depth = Number(row["data-depth"]);
      assert.ok(depth <= previousDepth + 1, "depth nests at most one level per row");
      previousDepth = depth;
      assert.match(row["data-at"], /^\S+:\d+$/, "data-at is path:line");
      assert.ok(text.trim(), "row names the call");
    }
  }
  const allMarks = new Set(
    stacks.flatMap((s) => [...s.body.matchAll(/data-mark="([^"]*)"/g)].map((m) => m[1])),
  );
  assert.deepEqual([...allMarks].sort(), [...MARKS].sort(), "the catalog shows every mark");
});

test("every code snippet has an id, escaped code, and in-range pins", () => {
  const slices = blocks("incpad-code");
  assert.ok(slices.length > 0, "catalog has a code annotation snippet");
  for (const slice of slices) {
    assert.ok(slice.attrs.id, "code block has a stable id");
    assert.ok(slice.attrs["data-path"], "code block has data-path");
    assert.match(slice.attrs["data-start"], /^\d+$/, "data-start is an integer");
    assert.doesNotMatch(slice.body, /^\n/, "code starts right after the opening tag");

    const { pins, lines } = parseCode(slice.body);
    for (const line of lines) {
      assert.doesNotMatch(line, /<|>/, `code line is HTML-escaped: ${line}`);
    }
    const first = Number(slice.attrs["data-start"]);
    const last = first + lines.length - 1;
    assert.ok(pins.length > 0, "snippet shows a pin");
    for (const pin of pins) {
      assert.ok(PIN_KINDS.has(pin.attrs.kind), `pin kind ${pin.attrs.kind} is info, warn, risk, or ok`);
      const line = Number(pin.attrs.line);
      assert.ok(Number.isInteger(line) && line >= first && line <= last, `pin line ${pin.attrs.line} is within ${first}-${last}`);
      assert.ok(pin.text, "pin says what to notice");
    }
  }
});
