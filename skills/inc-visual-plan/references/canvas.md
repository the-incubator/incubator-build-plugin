# Canvas authoring

This guidance is adapted from [BuilderIO/skills visual-plan canvas guidance](https://github.com/BuilderIO/skills/tree/main/skills/visual-plan), which is MIT licensed.
The source model follows the frozen Incubator Build plan API.

## When to use a canvas

Use `canvas.mdx` for UI states, product workflows, or visual alternatives that a reviewer must compare.
Do not use a canvas for backend-only, data-only, migration-only, or architecture-only plans.
Put those relationships in document blocks instead.

## Board structure

Use exactly one `DesignBoard` in `canvas.mdx`.
Group related frames in `Section` elements.
Put one `Artboard` around each meaningful user-visible state.
Put one semantic `Screen` inside each artboard.

```mdx
<DesignBoard title="Feature states" version={1}>
  <Section id="states" title="Primary flow">
    <Artboard id="default" label="Default" surface="browser">
      <Screen surface="browser" html={"<main>...</main>"} />
    </Artboard>
  </Section>
</DesignBoard>
```

Use stable ids for `Section`, `Artboard`, and `Annotation` when the catalog requires them.
Keep ids unique across `plan.mdx` and `canvas.mdx`.
Use `Annotation.targetId` only for an existing artboard in the same board.
Use `Connector.from` and `Connector.to` only for existing artboard ids.

## Layout rules

Use the catalog's surface presets.
Do not size a screen with ad hoc HTML dimensions.
The renderer owns screen pixels and frame chrome.
Use board coordinates only when the live catalog and task need deliberate frame placement.
Keep related states in nearby sections and connect only adjacent transitions.

Keep annotations short.
Anchor notes with `targetId` and `placement` so they remain attached when the board is rendered.
Do not put product explanations inside the screen HTML.

## Review check

Inspect the default board view.
Confirm that every frame is legible, every connector has two valid artboards, and every annotation has a valid target.
Confirm that the canvas is optional for document-only work.
