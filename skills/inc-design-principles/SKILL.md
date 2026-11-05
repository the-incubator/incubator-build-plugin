---
name: inc-design-principles
description: Use before a prototype or mockup, when asked to "design a few variations", redesign, build, polish, or review web or mobile UI, screens, layouts, components, or landing pages. Also use for "/inc-design-principles", visual design, responsive design, design tokens, interaction states, motion, or UI critique.
---

# Design principles

Apply these when designing, building, or reviewing any web or mobile interface.
When reviewing, check each section below and call out concrete violations.

## Start from the system

- Before building anything, find the existing color, type, spacing, radius, and shadow tokens and components; use them.
- Add new tokens and components to the system, not inline in a single screen.

## Push past the default

Models predict the most likely next choice, which produces safe, average design.
Great design bends the rules and creates an emotional response, so steer it deliberately.

- Start from a bold, specific creative direction rather than a generic request.
- Name the aesthetic, the mood, the layout idea, and the typography intent before writing any UI code.
- Inject the user's taste: ask for high-level ideas first, react to them, then refine into one precise direction.
- When exploring, generate a few clearly different directions rather than small variations of one.
- In an existing product, push within the system (composition, imagery, type scale, motion) before inventing new tokens; save new visual languages for new products or explicit explorations.
- Once a direction is chosen, commit to it consistently.

## Page layout

- Use one consistent left/right padding for the navbar, page content, and footer.
- Apply a max-width to the same three regions so content stays contained on large monitors.
- Define the gutter and max-width once (a shared container class or layout component) and reuse it, rather than re-declaring per page.
- Break these rules only selectively and on purpose.
- Keep items in a collection (grid, list, or multi-column list) uniform in size and anatomy, regardless of item type or data state. Preserve title, subtext, and timestamp slots when fields are missing; clamp long text to consistent line counts; use consistent media aspect ratios; and set fixed or stretch-to-row heights. Grid items in each row must share a height. In multi-column lists, aligned items across columns must share a height, even when rows span multiple lines.
- Carousels are the standard exception: they start and end at the screen edge, not at the padding edge.
- The first carousel item should align with the content gutter, and overflow should run to the viewport edge.
- A fade at the carousel edges is acceptable but not typical; prefer a plain edge bleed.

## Design every state

Design for the states real users actually hit, not just the happy path.
Before building, introspect the component, view, or page (route guards, auth, data model, permissions, flags, where it is used) to work out which states can reach it.
Design those, and skip states that are impossible or very rarely seen.

### Interaction states

- Hover and pressed: make interactive feedback clear.
- Focus: show a visible indicator for keyboard users.
- Disabled: look unavailable and, where possible, say why.
- Selected and active: distinguish the current item, tab, or filter.

### User states

Derive user states from context, not from a fixed list.
Evergreen states worth checking for:

- Signed out vs signed in.
- First run and onboarding vs returning user.
- Role and permission: hide or disable what a user cannot do rather than letting them hit an error.
- Plan or entitlement: free vs paid, trial, limit reached.
- Unverified or incomplete profile.

Context will surface others specific to the product (a creator vs a collector, a host vs a guest); design those too.

### Data states

- Loading: reserve space for images and async content, and size empty states to the container they replace, so nothing jumps when content arrives.
- Empty:
  - Every component that displays a list of items needs an empty state, never a bare heading, empty grid, or blank region.
  - Use one consistent look and feel for empty states across the app, especially when the missing items are similar in nature.
  - Build a shared empty state component: short text explaining what is missing, plus an optional CTA button that creates or finds the first item.
  - Keep empty state copy specific to the item type ("No orders yet") rather than generic ("Nothing here").
- Overflow: many items, the really long name, huge numbers; text wraps or truncates without breaking layout.
- Error: explain what went wrong and give the user a way forward.
- Optimistic and pending: a saved-but-not-confirmed change, plus the rollback when it fails.

## Mobile responsive design

- Drop desktop grouping containers on mobile (unless they are small cards): the screen width is already the container, and nesting causes double padding.
- Keep purposeful inner padding; remove desktop-only outer margins, borders, shadows, radii, and nested card surfaces.
- Reflow, do not shrink: stack side-by-side desktop regions vertically instead of squeezing them into narrow columns.
- Test at a real phone width (360 to 390px) with the content gutter applied and no horizontal scroll.
- Follow the 44px tap-target rule in Details, even for small icons.

## Motion

- Animate only transform and opacity.
- Use ease-out for anything entering.
- Keep animations under 250ms.

## Details

- Make nested corners concentric: outer radius = inner radius + padding.
- Make every tap target at least 44px, even when the icon inside is smaller.

## Subtract before you ship

AI loves to add more, but it rarely takes away.
Restraint looks premium: less on the screen holds attention without clutter.

### Do not overexplain

- Cut subtext, eyebrows, captions, helper copy, and labels that restate what the visual already communicates.
- If information matters but is currently a line of text, ask whether it should be captured visually instead (a thumbnail, a badge, a progress bar, a count in the corner).
- One title per element is enough. Titles plus subtitles plus descriptions plus tags is a tell.
- Do not add "explanatory" sections, tooltips, or onboarding copy the user did not ask for.
- Do not label the obvious: a search field does not need a "Search" caption above it.

### The subtraction pass

- Before finishing, do a dedicated pass whose only goal is to delete elements; the model needs an explicit push to do this.
- For each element ask: what really needs to be here, and what breaks if it is removed.
- If nothing breaks, remove it.

## Avoid AI tells

Remove patterns that feel overdone or obviously AI-generated:

- Gradients and glows used as decoration: gradient text, buttons, borders, glowing backgrounds or progress bars.
- Random accent colors or highlights on individual words.
- Uniform card grids with an icon, a bold title, and two lines of copy in every cell.
- Dense grids of small elements where a simpler, image-led layout would do.
- Emoji or icons used as bullets to fill visual space.
- Unnecessary containers, and rounded corners, shadows, and blur stacked on the same surface.
- Oversized or loose text; prefer smaller, simpler, tighter type.
- Generic copy ("Unlock the power of", "Seamlessly", "Elevate") in place of specific claims.

## Critique loop

Do not trust self-review of your own output.
Evaluate the result as an independent design critic.

- Judge from screenshots at desktop and mobile widths, not from the code.
- State what aesthetic the design is aiming for.
- Imagine the same brief executed by a top design studio and list the largest gaps.
- Check both high-level structure and fine details (alignment, spacing, type scale, contrast).
- Check every reachable state from Design every state, including uniform size and anatomy across collection items with missing fields, long text, or different states and types.
- Check the Motion and Details rules, including icon buttons.
- Penalize anything that looks overdone or obviously AI-generated.
- Give tight, specific feedback with concrete fixes, not vague prose.
- Be bold and opinionated rather than safe.
- Score out of 10 and only stop iterating at 9 or above, or when a clear stopping criterion is met.
