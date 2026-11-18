# Mobile-safe IncPad layout

Start with a viewport meta tag and adapt these classes to the artifact. The outer document must fit a phone; only the rail/table/code wrapper may scroll sideways. A clipped `body` conceals lost content, so it is not a substitute for a responsive layout.

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
<main class="pad-page">
  <nav class="pad-scroll pad-tabs" aria-label="Sections">
    <ul><li><a href="#overview">Overview</a></li><li><a href="#details">Details</a></li></ul>
  </nav>
  <div class="pad-grid">
    <section id="overview">Overview</section>
    <section id="details">Details</section>
  </div>
  <div class="pad-scroll" role="region" aria-label="Comparison table" tabindex="0">
    <table class="pad-wide-table"><tr><th>Option</th><th>Tradeoff</th></tr><tr><td>A</td><td>Example</td></tr></table>
  </div>
  <pre class="pad-code"><code>Long code wraps here instead of widening the page.</code></pre>
</main>
```

```css
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; overflow-wrap: anywhere; }
.pad-page { width: min(100%, 1080px); min-width: 0; margin-inline: auto; padding: 24px 16px; }
.pad-page > *, .pad-grid > *, .pad-flex > * { min-width: 0; }
.pad-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.pad-flex { display: flex; flex-wrap: wrap; }
img, video, canvas, iframe, .mermaid svg { max-width: 100%; height: auto; }
a, code, .pad-grid > *, .pad-flex > * { overflow-wrap: anywhere; }
.pad-scroll { max-width: 100%; min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; }
.pad-tabs ul { display: flex; gap: 8px; width: max-content; min-width: 100%; margin: 0; padding: 0; list-style: none; }
.pad-tabs li { flex: none; }
.pad-wide-table { width: max-content; min-width: 100%; border-collapse: collapse; }
.pad-code { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
/* If indentation must remain exact, wrap a white-space: pre block in .pad-scroll instead. */
@media (max-width: 640px) { .pad-grid { grid-template-columns: minmax(0, 1fr); } }
```

Use the same `.pad-scroll` wrapper around an intentionally wide Mermaid diagram; if legibility requires its natural size, set that diagram's SVG `max-width: none` *inside the wrapper only*. A short field/value table may instead use `width: 100%`, fixed column widths, and `overflow-wrap: anywhere` in cells. For full tables, keep the scrollable region keyboard-focusable and labeled as above. The [schema card](blocks.md#schema-cards-for-data-design) and [section nav](blocks.md#active-section-navigation) examples use the same bounded-layout principles.

## Pre-publish overflow check

At a 390px browser viewport, open the artifact itself (inside the IncPad iframe or its direct artifact URL), wait for fonts, media, and Mermaid, then evaluate this in that document. Repeat at 360px if the layout is dense and after each revision. It reports elements beyond the viewport, excluding children intentionally contained by a bounded horizontal scroller. Investigate the first ancestor in each result, not every table cell or tab link. The decisive assertion is `pageWidth <= viewport`.

```js
(() => {
  const viewport = document.documentElement.clientWidth;
  const boundedScroller = (element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const rect = parent.getBoundingClientRect();
      if (rect.left >= -1 && rect.right <= viewport + 1 &&
          /^(auto|scroll)$/.test(getComputedStyle(parent).overflowX) &&
          parent.scrollWidth > parent.clientWidth) return true;
    }
    return false;
  };
  return {
    viewport,
    pageWidth: document.documentElement.scrollWidth,
    offenders: [...document.body.querySelectorAll('*')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (rect.left < -1 || rect.right > viewport + 1) && !boundedScroller(element);
      })
      .slice(0, 20)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        className: typeof element.className === 'string' ? element.className : '',
        right: Math.round(element.getBoundingClientRect().right),
      })),
  };
})()
```

If `pageWidth` exceeds `viewport`, fix the authored source before publishing. If only viewer-injected controls overflow, report that separately; author CSS cannot correct an app-owned control. This browser check is deliberately part of authoring rather than the `inc-build` CLI: the CLI has no browser dependency and static HTML inspection cannot measure loaded fonts, images, or Mermaid geometry.
