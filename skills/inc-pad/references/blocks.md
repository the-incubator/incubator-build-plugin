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

A planning pad's Data design is a change-focused schema, not an OBJECT / FIELDS / NOTES table. Use ordinary artifact HTML and CSS (there is no injected schema component). Name each table and its state; use one row per column, with type and only constraints established by the plan. Keep relationship targets clickable. Do not invent a PK or FK just because two tables share a key. Use a labeled relationship line when the link is conceptual rather than a declared FK. A changed table shows only changed columns unless unchanged context is essential; dim that context. Give configuration or JSON metadata its own typed shape card. Keep migration/backfill detail in a collapsed `<details>` after the cards. For a schema with many rows, a two-column card grid on desktop and stacked cards on mobile makes the table boundaries clear.

The following is a small, self-contained authoring pattern. Put the CSS in the pad's `<style>` and the markup in its Data design section. Adapt the names and constraints to the actual schema; `?` means the type is not yet verified.

```css
.schema-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.schema-card { min-width: 0; border: 1px solid #d9dde5; border-radius: 12px; background: #fff; overflow: hidden; }
.schema-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; padding: 14px 16px; border-bottom: 1px solid #e7e9ed; }
.schema-head h3 { margin: 0; font: 600 15px/1.4 ui-monospace, monospace; overflow-wrap: anywhere; }
.schema-badge { border-radius: 4px; padding: 2px 6px; font: 700 11px/1.4 system-ui; text-transform: uppercase; background: #e8f4e9; color: #216233; }
.schema-badge.changed { background: #fff2db; color: #80500b; }
.schema-columns { margin: 0; padding: 0; list-style: none; }
.schema-columns li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 9px 16px; border-bottom: 1px solid #eff0f2; }
.schema-columns code { overflow-wrap: anywhere; font: 500 12px/1.5 ui-monospace, monospace; }
.schema-type { color: #626b7a; font: 12px/1.5 ui-monospace, monospace; text-align: right; }
.schema-flags { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px; color: #626b7a; font: 11px/1.5 system-ui; }
.schema-flags span, .schema-flags a { border-radius: 4px; padding: 1px 5px; background: #f1f3f6; color: #34435a; }
.schema-flags a { color: #245399; text-decoration: underline; text-underline-offset: 2px; }
.schema-flags a:focus-visible { outline: 2px solid #245399; outline-offset: 2px; }
.schema-note { margin: 0; padding: 10px 16px 14px; font: 12px/1.5 system-ui; color: #4d5665; }
@media (max-width: 720px) { .schema-grid { grid-template-columns: minmax(0, 1fr); } }
```

```html
<div class="schema-grid" aria-label="Data schema changes">
  <article class="schema-card" id="enrollments-schema">
    <header class="schema-head"><h3>auto_find_enrollments</h3><span class="schema-badge">New</span></header>
    <ul class="schema-columns">
      <li><code>id</code><span class="schema-type">uuid</span><span class="schema-flags"><span>PK</span></span></li>
      <li><code>campaign_id</code><span class="schema-type">uuid</span></li>
      <li><code>user_id</code><span class="schema-type">uuid</span></li>
      <li><code>status</code><span class="schema-type">enum</span><span class="schema-flags"><span>on</span><span>off</span><span>ended</span><span>NOT NULL</span></span></li>
      <li><code>submission_id</code><span class="schema-type">uuid</span><span class="schema-flags"><a href="#submissions-schema">FK → submissions.id</a></span></li>
    </ul>
    <p class="schema-note">Unique (campaign_id, user_id). Row-level security by tenant.</p>
  </article>
  <article class="schema-card" id="submissions-schema">
    <header class="schema-head"><h3>submissions</h3><span class="schema-badge changed">Changed</span></header>
    <ul class="schema-columns">
      <li><code>source</code><span class="schema-type">text</span><span class="schema-flags"><span>NEW</span><span>NOT NULL</span><span>DEFAULT 'player'</span><span>player</span><span>auto</span></span></li>
    </ul>
    <p class="schema-note">Only the new column is shown; unchanged columns are omitted.</p>
  </article>
  <article class="schema-card" id="config-shape">
    <header class="schema-head"><h3>social-post.autoFind?</h3><span class="schema-badge changed">Config shape</span></header>
    <ul class="schema-columns">
      <li><code>enabled</code><span class="schema-type">boolean</span><span class="schema-flags"><span>DEFAULT false</span></span></li>
      <li><code>scanAt</code><span class="schema-type">HH:mm</span><span class="schema-flags"><span>DEFAULT 23:15</span></span></li>
    </ul>
    <p class="schema-note">Lives in requirement metadata, not a database table.</p>
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
```

## Do not

- Do not include `<script>` or `<link>` tags for `/pad-editor/blocks.js` or `/pad-editor/blocks.css`; the app injects them.
- Do not define your own `incpad-callstack`, `incpad-code`, or `incpad-pin` elements, and do not restyle the runtime's internals; use the blocks as they render.
- Do not expect them to render outside IncPad: opened as a local file they show as unstyled text.
- Do not paste secrets, credentials, or private data into a code slice; anyone with the pad link can read it.
