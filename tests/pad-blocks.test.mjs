// Checks that the IncPad toolbox block snippets agents copy from the inc-pad skill
// follow the blocks runtime contract the web app renders: <incpad-callstack> rows with
// data-mark/data-depth/data-at, and <incpad-code> slices with in-range <incpad-pin>s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

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

test("multi-section navigation and open decisions stay linked and unified", () => {
  assert.match(skill, /For every pad with multiple sections, put a compact section navigation near the top/);
  assert.match(skill, /within the viewport at 360-390px/);
  assert.match(skill, /native fragment link/);
  assert.match(skill, /all open questions in one \*\*Decisions\*\* list/);
  assert.match(skill, /\*\*Product\*\* or \*\*Technical\*\*/);
  assert.match(skill, /link the decision to that section's anchor/);
  assert.match(skill, /forward link from the relevant section back to the decision/);
});

test("answered decisions in the catalog collapse with stable ids and read-only context", () => {
  assert.match(skill, /When publishing a later revision of the same pad, if the pad is still open and a decision has been answered/);
  assert.match(skill, /answered decision disclosure/);
  const snippet = htmlFences(catalog).find((html) => html.includes('id="decision-rollout"'));
  assert.ok(snippet, "catalog has a copyable answered-decision disclosure");
  assert.match(snippet, /^<details id="decision-rollout">/);
  assert.match(snippet, /<summary>Which rollout plan should the next revision use\? Answered: Pilot - one team first<\/summary>/);
  assert.match(snippet, /<legend>Which rollout plan should the next revision use\?<\/legend>/);
  assert.equal((snippet.match(/disabled>/g) ?? []).length, 2, "expanded options are read-only");
  assert.match(snippet, /Recorded answer: Pilot - one team first/);
  assert.doesNotMatch(snippet, /\bopen\b|Queue this answer|queuePrompt/);
  assert.match(catalog, /Keep open decisions, the risk callout/);
  assert.match(catalog, /Answered decisions in later revisions .* are the exception/);
});

test("planning guidance offers scannable schema cards and active navigation", () => {
  assert.match(skill, /schema-card pattern/);
  assert.match(skill, /Highlight the section currently in view/);
  assert.match(catalog, /## Schema cards for Data design/);
  const schema = htmlFences(catalog).find((html) => html.includes('class="schema-grid"'));
  assert.ok(schema, "schema example can be copied into a planning pad");
  assert.match(schema, /id="enrollments-schema"/);
  assert.match(schema, /id="submissions-schema"/);
  assert.match(schema, /<h3>Enrollment<\/h3>/);
  assert.match(schema, /<table class="schema-fields">/);
  assert.match(schema, /<th scope="row">Campaign<\/th><td>ID<\/td>/);
  assert.match(schema, /<th scope="row">Player<\/th><td>ID<\/td>/);
  assert.match(schema, /href="#submissions-schema">Submission/);
  assert.match(schema, /id="config-shape"/);
  assert.match(schema, /<details id="migration-detail"><summary>Migration and backfill/);
  assert.doesNotMatch(schema, /<thead\b|schema-columns|schema-flags/, "a reader sees a quiet field sheet, not a row-heavy catalog");
  assert.match(catalog, /\.schema-fields th, \.schema-fields td \{[^}]*border: 0/, "rows carry no horizontal rules");
  assert.match(catalog, /@media \(max-width: 720px\)/);
  const nav = htmlFences(catalog).find((html) => html.includes('id="section-nav"'));
  assert.match(nav, /aria-current="location"/);
});

test("copyable navigation highlights scroll and click targets and reveals overflowing pills", () => {
  const script = [...catalog.matchAll(/```js\n([\s\S]*?)```/g)][0]?.[1];
  assert.ok(script, "catalog includes an executable scroll-spy example");
  const handlers = {};
  const links = [0, 1, 2].map((i) => ({
    hash: ["#overview", "#data-design", "#risks"][i],
    offsetLeft: [0, 160, 310][i],
    offsetWidth: 100,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, fn) { handlers[`click${i}`] = fn; },
  }));
  const positions = [0, 300, 900];
  const sections = positions.map((_, i) => ({ getBoundingClientRect: () => ({ top: positions[i] }) }));
  const nav = {
    offsetLeft: 200, scrollLeft: 0, clientWidth: 300,
    querySelectorAll: () => links,
    getBoundingClientRect: () => ({ bottom: 48 }),
    scrollTo({ left }) { this.scrollLeft = left; },
  };
  const window = {
    scrollY: 0, innerHeight: 600,
    addEventListener(name, fn) { handlers[name] = fn; },
  };
  runInNewContext(script, {
    document: {
      querySelector: () => nav,
      getElementById: (id) => sections[["overview", "data-design", "risks"].indexOf(id)],
      documentElement: { scrollHeight: 1500 },
    },
    window,
    requestAnimationFrame: (fn) => fn(),
    decodeURIComponent,
  });
  handlers.load();
  assert.equal(links[0].attributes["aria-current"], "location");
  positions[1] = 50;
  handlers.scroll();
  assert.equal(links[1].attributes["aria-current"], "location", "section in view becomes active");
  assert.equal(links[0].attributes["aria-current"], undefined);
  assert.equal(nav.scrollLeft, 0, "visible links do not move the rail");
  positions[2] = 50;
  handlers.scroll();
  assert.equal(links[2].attributes["aria-current"], "location");
  assert.equal(nav.scrollLeft, 302, "inset rail scrolls the active pill into view");
  handlers.click1();
  assert.equal(links[1].attributes["aria-current"], "location", "click updates immediately");
  positions[2] = 900;
  window.scrollY = 900;
  handlers.scroll();
  assert.equal(links[2].attributes["aria-current"], "location", "last section wins at page bottom");
  window.scrollY = 0;
  handlers.resize();
  assert.equal(links[1].attributes["aria-current"], "location", "resize refreshes the active section");
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

function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `catalog CSS has ${selector}`);
  return match[1];
}

test("risk callout and evidence snippets are glanceable and collapsed by default", () => {
  assert.match(skill, /Every Risks section leads with one overall severity callout/);
  assert.match(skill, /You can skip this section/);
  assert.match(skill, /Every Evidence section is one closed disclosure/);
  assert.match(skill, /prose, quotes, logs, and file lists/);
  assert.match(skill, /Keep them outside every `<details>`, including Evidence/);
  assert.match(catalog, /prose, quotes, logs, and file lists only/);
  assert.doesNotMatch(catalog, /Evidence section is the exception/);
  assert.match(skill, /references\/blocks\.md#risk-severity/);
  assert.match(skill, /references\/blocks\.md#collapsed-evidence/);
  assert.match(skill, /Do not use the injected `\.ipb-pill` styles for this/);
  assert.match(catalog, /## Risk severity/);
  assert.match(catalog, /## Collapsed evidence/);

  const css = [...catalog.matchAll(/```css\n([\s\S]*?)```/g)].map((match) => match[1]).find((block) => block.includes(".risk-callout"));
  assert.ok(css, "catalog includes copyable risk callout CSS");
  assert.match(css, /flex-wrap: wrap/);
  assert.match(css, /min-width: 0/);
  assert.match(rule(css, ".pad-evidence"), /scroll-margin-top: 70px/, "an Evidence link clears the sticky section nav");
  assert.match(catalog, /h2\[id\], section\[id\], details\[id\] \{ scroll-margin-top: 70px; \}/);
  assert.match(rule(css, ".risk-callout .risk-badge"), /font-size: 18px/, "the overall badge is larger than a group chip");
  assert.match(rule(css, ".risk-badge"), /font: 700 12px/);

  const badgeColors = {};
  for (const severity of ["high", "medium", "low"]) {
    const declaration = rule(css, `.risk-badge[data-severity="${severity}"]`);
    const background = declaration.match(/background: (#[0-9a-f]{6})/i)?.[1];
    const foreground = declaration.match(/color: (#[0-9a-f]{6})/i)?.[1];
    assert.ok(background && foreground, `${severity} badge sets its own colors`);
    assert.ok(contrast(foreground, background) >= 4.5, `${severity} badge text contrasts with its fill`);
    badgeColors[severity] = background;
  }
  assert.equal(new Set(Object.values(badgeColors)).size, 3, "High, Medium, and Low use different fills");

  const fences = htmlFences(catalog);
  const high = fences.find((html) => html.includes('id="risk-callout"'));
  assert.ok(high, "catalog has a High or Medium risk snippet");
  assert.match(high, /<span class="risk-badge" data-severity="high">High<\/span>/);
  assert.match(high, /<span class="risk-badge" data-severity="medium">Medium<\/span>/);
  assert.match(high, /<span class="risk-badge" data-severity="low">Low<\/span>/);
  assert.doesNotMatch(high, /<details[^>]*>[\s\S]*id="risk-callout"/, "the callout stays outside the disclosure");
  assert.doesNotMatch(high, /<details[^>]*>[\s\S]*data-severity="low"/, "a Low group stays visible when the section is open");
  assert.match(high, /<details id="risks-detail">/);
  assert.doesNotMatch(high, /<details\b[^>]*\bopen\b/);

  const low = fences.find((html) => html.includes('id="risk-callout-low"'));
  assert.ok(low, "catalog has a Low-only risk snippet");
  assert.match(low, /<span class="risk-badge" data-severity="low">Low<\/span>/);
  assert.match(low, /You can skip this section/);
  assert.match(low, /<details id="risks-low-lines">/);
  assert.doesNotMatch(low, /<details\b[^>]*\bopen\b/);

  const evidence = fences.find((html) => html.includes('id="evidence"'));
  assert.ok(evidence, "catalog has a collapsed Evidence snippet");
  assert.match(evidence, /^<details class="pad-evidence" id="evidence">/);
  assert.match(evidence, /<summary>Evidence<\/summary>/);
  assert.doesNotMatch(evidence, /\bopen\b/);
  assert.doesNotMatch(evidence, /<h2>Evidence<\/h2>/, "the summary is the only Evidence heading");
});
