# IncPad toolbox blocks

IncPad ships standard blocks that any pad can use without bundling its own CSS or JavaScript.
The web app injects a blocks runtime into every pad artifact, next to the artifact SDK:

- `/pad-editor/blocks.js` defines the custom elements `<incpad-callstack>` and `<incpad-code>`.
- `/pad-editor/blocks.css` styles them with the IncPad chrome tokens.

You do not add `<script>` or `<link>` tags for them.
Write the markup below in the pad HTML and the runtime renders it when the pad loads.

| Block | Element | Use it when the decision depends on |
| --- | --- | --- |
| Call stack | `<incpad-callstack>` | Which code path a change runs through, and which calls it adds, changes, removes, or leaves open |
| Code annotation | `<incpad-code>` | Specific lines of a file slice or sketch, with the agent's calls on what is safe, risky, or worth a look |

## Collapsed supporting detail

The injected toolbox has no disclosure block. Use native HTML `<details>` with a visible `<summary>` for optional in-depth prose below a section's open, scannable answer. Omit the `open` attribute so the detail starts collapsed. Keep decisions, risks, Mermaid diagrams, and toolbox blocks outside the disclosure so they remain visible and commentable. Give each disclosure a stable id across pad revisions.

```html
<section id="storage-design">
  <h2>Data design and storage</h2>
  <p>No new table is needed. Add <code>status</code> to the existing jobs table.</p>
  <details id="storage-design-detail">
    <summary>Field and migration detail</summary>
    <p>Backfill existing rows with the current job state before making the field required.</p>
  </details>
</section>
```

## Decision first

A block is evidence for a decision, not decoration.
Put the decision or question the reviewer must answer above the block, and the block directly under it.
Show only the calls or lines that bear on that decision: a 6 to 15 row call stack or a 5 to 30 line code slice is usually enough.
Pin only lines you want the reviewer to look at; a pin on every line is noise.
Use a Mermaid diagram (see SKILL.md) for architecture and flows between systems, and a call stack for the function-level path through one change.

## Comment targets

Every rendered call stack row and every code line gets a stable `id` and `data-annotate`, so the reviewer can click any row or line to comment on it or select text in it to annotate.
Those comments arrive in `pad poll` as ordinary `comment` items: `selector` is anchored on that row's or line's id, and `selected_text` holds the highlighted text or, for a click, the row's or line's own text.
Match those against your block's rows or lines to find exactly what the reviewer meant, then edit that part.

Give each block element its own stable, meaningful `id`, such as `id="save-path"` or `id="revisions-slice"`.
Keep the block's id across revisions, and avoid reordering rows or shifting lines without a reason, because row and line ids may derive from position and feedback selectors resolve through them.
Target a whole block in `pad update --changes` by its id, for example `{"kind": "modified", "target": "#save-path", "label": "Marked the cache write as removed"}`.

## Call stack

One `<li>` per call, in call order, inside `<incpad-callstack>`.

| Attribute | Required | Value |
| --- | --- | --- |
| `data-mark` | yes | `+` added, `~` changed, `-` removed, `?` open question or unverified |
| `data-depth` | yes | Integer nesting level; `0` is the entry point, each callee is one deeper |
| `data-at` | yes | `path:line` where the call lives, such as `apps/web/lib/pads/revisions.ts:40` |
| `data-note` | no | One short line on why this call matters to the decision |

The `<li>` text is the call itself, such as `createRevision(padId, input)`.
Escape HTML in the row text as in code slices: write `&lt;` for `<`, `&gt;` for `>`, and `&amp;` for `&`, so `handler<Result>()` becomes `handler&lt;Result&gt;()`.
In `data-note` and other attribute values, write `&amp;` for `&` and `&quot;` for `"`.

```html
<incpad-callstack id="save-path" aria-label="Revision save path">
  <li data-mark="~" data-depth="0" data-at="apps/web/app/api/pads/[id]/revisions/route.ts:18" data-note="Validates summary and changes before insert">POST /api/pads/:id/revisions</li>
  <li data-mark="~" data-depth="1" data-at="apps/web/lib/pads/revisions.ts:40">createRevision(padId, input)</li>
  <li data-mark="+" data-depth="2" data-at="apps/web/lib/pads/revisions.ts:43" data-note="New: rejects more than 50 changes">validateChanges(input.changes ?? [])</li>
  <li data-mark="-" data-depth="2" data-at="apps/web/lib/pads/summary.ts:12">legacySummaryFallback(input)</li>
  <li data-mark="?" data-depth="2" data-at="apps/web/lib/pads/storage.ts:12" data-note="Does the upload retry on a 409?">uploadRevisionFiles(padId, files)</li>
</incpad-callstack>
```

Use `?` for calls you have not verified or that hold an open question, and say what is open in `data-note`, so the reviewer can answer it with a comment on that row.

## Code annotation

`<incpad-code>` wraps the raw text of a file slice or a sketch.

| Attribute | Required | Value |
| --- | --- | --- |
| `data-path` | yes | The file path shown in the block header, or a label such as `sketch: proposed guard` for code that does not exist yet |
| `data-start` | yes | Integer line number of the first code line |

Rules for the code text:

- Start the code immediately after the opening tag's `>`, so the first line is line `data-start`.
- Escape HTML in the code: write `&lt;` for `<`, `&gt;` for `>`, and `&amp;` for `&`.
  The block is parsed as HTML before the runtime sees it, so an unescaped `<` can swallow the rest of the slice.
- Keep the file's real indentation; the runtime preserves whitespace.
- Copy a real slice verbatim with its real starting line, or label it a sketch in `data-path` so nobody mistakes it for live code.

Add an `<incpad-pin>` after the code for each line you want to call out.

| Attribute | Required | Value |
| --- | --- | --- |
| `line` | yes | Line number the pin points at, between `data-start` and the slice's last line |
| `kind` | yes | `info` context, `warn` worth a look, `risk` likely bug or decision needed, `ok` checked and fine |

The pin text is one or two sentences that say what the reviewer should notice and why it matters to the decision.
Escape it the same way as the code.

```html
<incpad-code id="revisions-slice" data-path="apps/web/lib/pads/revisions.ts" data-start="40">export async function createRevision(padId: string, input: RevisionInput): Promise&lt;Revision&gt; {
  const next = await nextRevisionNumber(padId)
  const summary = input.summary?.trim() || null
  const changes = validateChanges(input.changes ?? [])
  return db.insert(padRevisions).values({ padId, revision: next, summary, changes })
}
<incpad-pin line="42" kind="warn">An empty summary becomes null, so the revision step shows no one-liner unless the agent sent one.</incpad-pin>
<incpad-pin line="43" kind="ok">The 50-change limit matches the CLI's, so a valid client payload is never rejected here.</incpad-pin>
</incpad-code>
```

Line-level comments and text annotations on any line work like other pad comments; there is no separate propose-edit flow in this contract.
When a reviewer comments a replacement on a line, apply it to the slice or sketch in the next revision and declare the change.

## Schema cards for Data design

A planning pad's Data design should feel like a simple object sketch, not a database table. Use one compact card per changed table or configuration shape. Lead with a human name and a short `Field: meaning` list inside braces; place the real table/key name quietly beneath the title for implementers. Say `ID`, `number`, `date`, `text`, or the possible choices when the reader does not need SQL types. Prefer `Player: ID` over `user_id uuid UNIQUE pair with campaign_id` repeated in every field. Put the rule once beneath the shape: `One enrollment per campaign and player.` Keep only changed fields on changed objects. Link related cards in a short sentence without claiming an unverified foreign key. Give JSON metadata its own shape. Keep migration/backfill detail in a collapsed `<details>` below. Two cards may sit side by side on desktop; stack them at 360-390px.

This self-contained authoring pattern uses ordinary artifact HTML and CSS (there is no injected schema component). Put CSS in the pad's `<style>` and markup in its Data design section. Keep the shape short enough to scan; move exhaustive column lists and SQL details into the collapsed migration section when a reviewer needs them.

```css
.schema-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.schema-card { min-width: 0; padding: 18px 20px; border: 1px solid #d9dde5; border-radius: 12px; background: #fff; }
.schema-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.schema-head h3 { margin: 0; font: 600 17px/1.3 system-ui; }
.schema-key { margin: 2px 0 12px; color: #626b7a; font: 11px/1.4 ui-monospace, monospace; overflow-wrap: anywhere; }
.schema-badge { border-radius: 4px; padding: 2px 6px; font: 700 11px/1.4 system-ui; text-transform: uppercase; background: #e8f4e9; color: #216233; }
.schema-badge.changed { background: #fff2db; color: #80500b; }
.schema-brace { display: block; color: #8590a0; font: 16px/1.4 ui-monospace, monospace; }
.schema-fields { margin: 2px 0 2px 12px; padding: 0; list-style: none; font: 13px/1.7 system-ui; }
.schema-fields li { overflow-wrap: anywhere; }
.schema-fields strong { font-weight: 600; }
.schema-fields a { color: #245399; text-underline-offset: 2px; }
.schema-fields a:focus-visible { outline: 2px solid #245399; outline-offset: 2px; }
.schema-notes { margin: 12px 0 0; color: #4d5665; font: 12px/1.5 system-ui; }
.schema-notes p { margin: 4px 0 0; }
@media (max-width: 720px) { .schema-grid { grid-template-columns: minmax(0, 1fr); } }
```

```html
<div class="schema-grid" aria-label="Data shapes">
  <article class="schema-card" id="enrollments-schema">
    <header class="schema-head"><h3>Enrollment</h3><span class="schema-badge">New</span></header>
    <p class="schema-key">auto_find_enrollments</p>
    <span class="schema-brace" aria-hidden="true">{</span>
    <ul class="schema-fields">
      <li><strong>Campaign:</strong> ID</li>
      <li><strong>Player:</strong> ID</li>
      <li><strong>Status:</strong> On / Off / Paused / Ended</li>
      <li><strong>Started from:</strong> <a href="#submissions-schema">Submission</a></li>
    </ul>
    <span class="schema-brace" aria-hidden="true">}</span>
    <div class="schema-notes"><p>One enrollment per campaign and player.</p><p>Only this tenant can see it.</p></div>
  </article>
  <article class="schema-card" id="submissions-schema">
    <header class="schema-head"><h3>Submission</h3><span class="schema-badge changed">Changed</span></header>
    <p class="schema-key">social_post_submissions · new field only</p>
    <span class="schema-brace" aria-hidden="true">{</span>
    <ul class="schema-fields"><li><strong>Source:</strong> Player / Auto</li></ul>
    <span class="schema-brace" aria-hidden="true">}</span>
    <div class="schema-notes"><p>Required. Defaults to Player.</p></div>
  </article>
  <article class="schema-card" id="config-shape">
    <header class="schema-head"><h3>Auto-find options</h3><span class="schema-badge changed">Config</span></header>
    <p class="schema-key">social-post.autoFind? · metadata, not a table</p>
    <span class="schema-brace" aria-hidden="true">{</span>
    <ul class="schema-fields">
      <li><strong>Enabled:</strong> Yes / No</li>
      <li><strong>Scan time:</strong> 23:15</li>
    </ul>
    <span class="schema-brace" aria-hidden="true">}</span>
    <div class="schema-notes"><p>Off by default.</p></div>
  </article>
</div>
<details id="migration-detail"><summary>Migration and backfill</summary><p>Add the column with its default before enabling automated writes.</p></details>
```

## Active section navigation

For multi-section pads, retain native fragment links. Use a scrollable sticky rail and an active pill. The artifact can run its own JavaScript; the injected toolbox does not provide a scroll-spy. This pattern chooses the last section whose top has crossed the sticky rail's bottom edge. It marks the clicked pill immediately, then corrects it on scroll, and scrolls only the *rail* horizontally so the active pill remains visible. IDs on sections and links remain stable across revisions. Include both CSS and JS in the authored HTML; no IncPad app changes are needed.

```html
<nav class="section-nav" aria-label="Sections" id="section-nav">
  <ul>
    <li><a href="#overview" aria-current="location">Overview</a></li>
    <li><a href="#data-design">Data</a></li>
    <li><a href="#risks">Risks</a></li>
  </ul>
</nav>
<section><h2 id="overview">Overview</h2></section>
<section><h2 id="data-design">Data design</h2></section>
<section><h2 id="risks">Risks</h2></section>
```

```css
.section-nav { position: sticky; top: 0; z-index: 2; overflow-x: auto; padding: 8px; background: #fff; scrollbar-width: thin; }
.section-nav ul { display: flex; gap: 4px; width: max-content; margin: 0; padding: 0; list-style: none; }
.section-nav a { display: block; padding: 8px 12px; border-radius: 6px; color: #4d5665; text-decoration: none; }
.section-nav a[aria-current="location"] { background: #e6edfa; color: #234d90; font-weight: 700; }
.section-nav a:focus-visible { outline: 2px solid #245399; outline-offset: -2px; }
h2[id] { scroll-margin-top: 70px; }
```

```js
const nav = document.querySelector('#section-nav');
const links = [...nav.querySelectorAll('a[href^="#"]')];
const sections = links.map(link => document.getElementById(decodeURIComponent(link.hash.slice(1))));
function activate(index) {
  links.forEach((link, i) => {
    if (i === index) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  const link = links[index];
  if (link) {
    const left = link.offsetLeft;
    if (left < nav.scrollLeft || left + link.offsetWidth > nav.scrollLeft + nav.clientWidth) {
      nav.scrollTo({ left: Math.max(0, left - 8), behavior: 'smooth' });
    }
  }
}
links.forEach((link, i) => link.addEventListener('click', () => activate(i)));
let pending = false;
function updateActive() {
  const threshold = nav.getBoundingClientRect().bottom + 32;
  let active = 0;
  sections.forEach((section, i) => {
    if (section && section.getBoundingClientRect().top <= threshold) active = i;
  });
  if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) active = sections.length - 1;
  activate(active);
}
window.addEventListener('scroll', () => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { updateActive(); pending = false; });
}, { passive: true });
window.addEventListener('load', updateActive);
window.addEventListener('resize', updateActive);
```

## Do not

- Do not include `<script>` or `<link>` tags for `/pad-editor/blocks.js` or `/pad-editor/blocks.css`; the app injects them.
- Do not define your own `incpad-callstack`, `incpad-code`, or `incpad-pin` elements, and do not restyle the runtime's internals; use the blocks as they render.
- Do not expect them to render outside IncPad: opened as a local file they show as unstyled text.
- Do not paste secrets, credentials, or private data into a code slice; anyone with the pad link can read it.
