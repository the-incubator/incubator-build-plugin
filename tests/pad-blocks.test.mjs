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
// The only entities the contract uses; any other `&` would render as different text.
const UNESCAPED_AMP = /&(?!(?:lt|gt|amp|quot);)/;

function htmlFences(markdown) {
  return [...markdown.matchAll(/```html\n([\s\S]*?)```/g)].map((m) => m[1]);
}

// Parse an opening tag's attributes, failing on anything that is not name="value",
// such as a stray quote that would cut an attribute value short in the browser.
function attrs(tag) {
  assert.match(tag, /^(?:\s+[\w-]+="[^"]*")*\s*$/, `attributes are well-formed: ${tag}`);
  const parsed = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  for (const [name, value] of Object.entries(parsed)) {
    assert.doesNotMatch(value, UNESCAPED_AMP, `${name} escapes & as &amp;: ${value}`);
  }
  return parsed;
}

// Text content is parsed as HTML, so it must not hold raw <, >, or & outside an escape.
function assertEscaped(text, what) {
  assert.doesNotMatch(text, /[<>]/, `${what} escapes < and >: ${text}`);
  assert.doesNotMatch(text, UNESCAPED_AMP, `${what} escapes & as &amp;: ${text}`);
}

// Match every <name ...>...</name> element, failing if any opening tag has no close.
function elements(html, name, what) {
  const found = [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`, "g"))];
  const opened = html.match(new RegExp(`<${name}\\b`, "g")) ?? [];
  assert.equal(found.length, opened.length, `every ${what} has a closing </${name}>`);
  return found.map((m) => ({ attrs: attrs(m[1]), body: m[2] }));
}

function blocks(name) {
  return htmlFences(catalog).flatMap((html) => elements(html, name, `<${name}>`));
}

// Parse a code block the way the contract defines it: raw text with <incpad-pin> children.
function parseCode(body) {
  const pins = elements(body, "incpad-pin", "pin").map((pin) => ({ attrs: pin.attrs, text: pin.body.trim() }));
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

test("every call stack snippet has an id and contract-valid, escaped rows", () => {
  const stacks = blocks("incpad-callstack");
  assert.ok(stacks.length > 0, "catalog has a call stack snippet");
  const allMarks = new Set();
  for (const stack of stacks) {
    assert.ok(stack.attrs.id, "call stack has a stable id");
    const rows = elements(stack.body, "li", "row");
    assert.equal(
      stack.body.replace(/<li\b[^>]*>[\s\S]*?<\/li>/g, "").trim(),
      "",
      "call stack holds only <li> rows",
    );
    assert.ok(rows.length > 0, "call stack has rows");
    let previousDepth = -1;
    for (const { attrs: row, body: text } of rows) {
      assert.ok(MARKS.has(row["data-mark"]), `mark ${row["data-mark"]} is one of + ~ - ?`);
      allMarks.add(row["data-mark"]);
      assert.match(row["data-depth"], /^\d+$/, "depth is a non-negative integer");
      const depth = Number(row["data-depth"]);
      assert.ok(depth <= previousDepth + 1, "depth nests at most one level per row");
      previousDepth = depth;
      assert.match(row["data-at"], /^\S+:\d+$/, "data-at is path:line");
      assert.ok(text.trim(), "row names the call");
      assertEscaped(text, "row text");
    }
  }
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
    for (const line of lines) assertEscaped(line, "code line");
    const first = Number(slice.attrs["data-start"]);
    const last = first + lines.length - 1;
    assert.ok(pins.length > 0, "snippet shows a pin");
    for (const pin of pins) {
      assert.ok(PIN_KINDS.has(pin.attrs.kind), `pin kind ${pin.attrs.kind} is info, warn, risk, or ok`);
      const line = Number(pin.attrs.line);
      assert.ok(Number.isInteger(line) && line >= first && line <= last, `pin line ${pin.attrs.line} is within ${first}-${last}`);
      assert.ok(pin.text, "pin says what to notice");
      assertEscaped(pin.text, "pin text");
    }
  }
});
