# Wireframe authoring

This guidance is adapted from [BuilderIO/skills visual-plan wireframe guidance](https://github.com/BuilderIO/skills/tree/main/skills/visual-plan), which is MIT licensed.
It is narrowed to the hosted Incubator Build block catalog.

## Whether to wireframe at all

A wireframe is a tool for one job: letting the reviewer compare visible screen states to make a call.
Reach for it only when the decision is about what the user would see.

- If the reviewer must weigh two on-screen states against each other — a default versus an error, a before versus an after, a new layout versus the current one — a `Wireframe` or `Screen` carries the decision.
- If the call is about behavior, data shape, sequencing, or a trade-off with no visual difference, do not wireframe.
  A `Table`, `Callout`, or `Decision` comparison states it more directly and the reviewer reads it faster.
- An anemic wireframe — device chrome around three labels and an empty panel — is worse than one clear sentence.
  If you cannot fill the screen with a real product state, the wireframe is not the right block.

When a wireframe does earn its place, make it content-rich per the sections below.

## Renderer-owned pixels

Write the user's information architecture, labels, hierarchy, and interaction states.
Do not design the CSS pixels in the plan source.

- Use semantic elements such as `header`, `nav`, `main`, `section`, `form`, `label`, `button`, and `footer`.
- Do not use inline colors, font sizes, spacing, dimensions, shadows, or arbitrary visual styles.
- Do not add `<style>`, `<script>`, `<html>`, `<head>`, or `<body>` tags.
- Do not use host framework classes or invented design-system classes.
- Use only tokens, helper classes, and icon names returned by the current `inc-build plan blocks` call.
- Use `data-icon="name"` markers for icons when the catalog supports the name.
- Put text in the markup so the reviewer can inspect the real state.

The renderer owns surface width, frame chrome, typography, spacing, colors, and the sketch or clean treatment.
Choose the catalog surface that matches the state: `browser`, `desktop`, `mobile`, `popover`, or `panel`.

## Content bar

Make each screen communicate a real product state.
Include the primary navigation, page title, relevant controls, meaningful data, empty or loading states when they matter, and the primary action.
Use realistic labels and values from the codebase.
Do not fill the screen with lorem ipsum or a decorative dashboard.

Keep a screen focused on one state.
Use separate screens for a default state, an error, an empty state, a popover, or a confirmation when those states affect the decision.

## Safe structure

Keep repeated patterns consistent within a plan.
Prefer one obvious hierarchy over many nested decorative boxes.
Use accessible labels and button text.
Do not embed architecture notes, implementation tasks, or long explanations inside a screen.
Put those notes in `plan.mdx` or a canvas annotation.

Before creating or changing a wireframe, fetch the live catalog again.
If the catalog does not expose a tag, prop, helper, token, or icon, do not invent it.
