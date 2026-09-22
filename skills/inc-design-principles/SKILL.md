---
name: inc:design-principles
description: Design principles to apply before designing, prototyping, building, or reviewing any visual web or mobile interface. Covers page layout (shared gutters, max-width, edge-bleed carousels), empty states, mobile responsiveness, subtraction and not overexplaining, AI tells, pushing past safe default design, and a critique loop. Use when the user says "design principles", "/inc:design-principles", asks to build or polish UI, or wants a design reviewed.
---

# Design principles

Apply these when designing, building, or reviewing any web or mobile interface.
When reviewing, check each section below and call out concrete violations.

## Page layout

- Use one consistent left/right padding for the navbar, page content, and footer.
- Apply a max-width to the same three regions so content stays contained on large monitors.
- Define the gutter and max-width once (a shared container class or layout component) and reuse it, rather than re-declaring per page.
- Break these rules only selectively and on purpose.
- Carousels are the standard exception: they start and end at the screen edge, not at the padding edge.
- The first carousel item should align with the content gutter, and overflow should run to the viewport edge.
- A fade at the carousel edges is acceptable but not typical; prefer a plain edge bleed.

## Empty states

- Every component that displays a list of items needs an empty state.
- Never render a bare heading, an empty grid, or a blank region when there is nothing to show.
- Use one consistent look and feel for empty states across the app, especially when the missing items are similar in nature.
- Build a shared empty state component: short text explaining what is missing, plus an optional CTA button that creates or finds the first item.
- Keep empty state copy specific to the item type ("No orders yet") rather than generic ("Nothing here").
- Match the empty state to the container it replaces so the layout does not jump when items arrive.

## Mobile responsive design

- Avoid reusing containers from the desktop design on mobile unless the container is a small card.
- Containers that group things on desktop usually create a double padding effect on mobile: padding outside the container, then again inside its content.
- The limited screen width already acts as the container, so remove the outer container and use the constrained full width of mobile as the natural boundary.
- Keep the content's purposeful inner padding, but drop desktop-only outer margins, framing, borders, shadows, radii, and nested card surfaces that waste mobile width.
- Reflow, do not shrink: stack side-by-side desktop regions vertically instead of squeezing them into narrow columns.
- Test at a real phone width (360 to 390px) with the content gutter applied and no horizontal scroll.

## Subtract before you ship

AI loves to add more, but it rarely takes away.
One of the biggest signs a design is AI-generated is that it overexplains everything or contains elements with no practical purpose.
A design that exercises restraint immediately looks premium and tasteful.
Putting less on the screen communicates more, because you hold attention without clutter.

### Do not overexplain

- Cut subtext, captions, helper copy, and labels that restate what the visual already communicates.
- If an image, icon, color, or layout already carries the meaning, no text should repeat it.
- If information matters but is currently a line of text, ask whether it should be captured visually instead (a thumbnail, a badge, a progress bar, a count in the corner).
- One title per element is enough. Titles plus subtitles plus descriptions plus tags is a tell.
- Do not add "explanatory" sections, tooltips, or onboarding copy the user did not ask for.
- Do not label the obvious: a search field does not need a "Search" caption above it.

### Remove decoration and noise

- Remove gradients, glows, and unnecessary containers.
- Remove random colors and highlights on text that serve no purpose.
- Replace custom buttons and text fields with native or system components when the custom version is not clearly better.
- Prefer simpler layouts and image-centric organization over dense grids of small elements.
- Prefer smaller, simpler, tighter text.
- Let the visuals speak on their own.

### The subtraction pass

- Stripping down a design and deleting code feels risky to the model, so it needs an explicit push.
- Before finishing, do a dedicated pass whose only goal is to delete elements.
- For each element ask: what really needs to be here, and what breaks if it is removed.
- If nothing breaks, remove it.

## Avoid AI tells

Watch for patterns that feel overdone, excessive, or obviously AI-generated, and remove them.

- Glowy effects in the background or on progress bars.
- Gradient text, gradient buttons, and gradient borders used as decoration.
- Uniform card grids with an icon, a bold title, and two lines of copy in every cell.
- Random accent colors applied to individual words.
- Emoji or icons used as bullets to fill visual space.
- Redundant labels that restate what the control already shows.
- Excessive rounded corners, shadows, and blur stacked on the same surface.
- Generic copy ("Unlock the power of", "Seamlessly", "Elevate") in place of specific claims.

## Push past the default

Models predict the most likely next choice, which produces safe, average design.
Great design bends the rules and creates an emotional response, so steer it deliberately.

- Start from a bold, specific creative direction rather than a generic request.
- Name the aesthetic, the mood, the layout idea, and the typography intent before writing any UI code.
- Inject the user's taste: ask for high-level ideas first, react to them, then refine into one precise direction.
- When exploring, generate a few clearly different directions rather than small variations of one.
- Once a direction is chosen, commit to it consistently across every screen and state.

## Critique loop

Do not trust self-review of your own output.
Evaluate the result as an independent design critic.

- Judge from screenshots at desktop and mobile widths, not from the code.
- State what aesthetic the design is aiming for.
- Imagine the same brief executed by a top design studio and list the largest gaps.
- Check both high-level structure and fine details (alignment, spacing, type scale, contrast).
- Penalize anything that looks overdone or obviously AI-generated.
- Give tight, specific feedback with concrete fixes, not vague prose.
- Be bold and opinionated rather than safe.
- Score out of 10 and only stop iterating at 9 or above, or when a clear stopping criterion is met.
