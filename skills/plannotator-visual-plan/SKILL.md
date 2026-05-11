---
name: plannotator-visual-plan
description: >
  Generate rich, standalone HTML implementation plans with inline SVG architecture diagrams,
  UI mockups, data flow visualizations, and syntax-highlighted code snippets. Use this skill
  whenever the user asks to create an implementation plan, technical design doc, architecture
  overview, feature spec, or migration guide — or whenever you're presenting a complex plan
  that would benefit from spatial, visual layout instead of flat markdown. Also trigger when
  the user says "make a plan", "design doc", "write up the approach", "show me the architecture",
  or wants to visualize how components connect. If you're about to present a multi-component plan,
  this skill almost certainly produces something more useful than markdown.
---

# Visual Implementation Plan

You produce single-file, zero-dependency HTML documents that make implementation plans genuinely useful to read. These aren't markdown rendered to HTML — they're spatial, visual documents with architecture diagrams drawn in SVG, UI mockups built in CSS, code snippets with syntax highlighting, and information arranged in grids rather than walls of text.

The plan HTML uses the Plannotator theme system, so it works standalone (with bundled defaults) and can be embedded in the Plannotator review UI with full theme inheritance.

## When to generate

Create an HTML plan when the work involves:
- Multiple components or services that interact
- UI changes worth mocking up
- Data flow or state transitions worth diagramming
- Significant code changes where key interfaces matter
- Architecture decisions with tradeoffs to visualize

For simple, linear tasks (rename a variable, fix a typo), plain markdown is fine. Don't force HTML when the content doesn't benefit from spatial layout.

## How to use this skill

1. Read `references/design-system.md` — color tokens, typography, and component patterns built on Plannotator's theme
2. Read `references/svg-patterns.md` — SVG diagram building blocks (architecture, flowcharts, data flow, charts)
3. Analyze the task and decide which sections and visual elements serve it best
4. Generate the HTML file and save it (typically to the project root or `/tmp/plan-{slug}.html`)
5. Tell the user where the file is so they can open it

## Document anatomy

Every plan needs a header and at least two substantive sections. Beyond that, choose sections that serve the specific plan — not every plan needs every section type.

### Required: Header

- **Eyebrow label**: project context, mono, small, uppercase (`--muted-foreground`)
- **Title**: what's being built, display font, large
- **Prompt box**: the original task/brief that motivated this plan (helps readers understand intent)

### Section menu — pick what fits

**Solution overview** — Narrative explanation: what are we building, why this approach? Keep concise — diagrams and code below carry the detail. Use a summary strip (stat cards) if there are key numbers worth surfacing upfront (components affected, new endpoints, new tables, etc.).

**Architecture / data flow diagram** — SVG diagram showing how components connect. See `references/svg-patterns.md`. Use whenever there are 3+ interacting components or when request/response flow matters.

**UI mockups** — Build mockups in HTML/CSS directly, not as descriptions. Show layout, colors, component structure. These communicate design intent, not pixel-perfection.

**Key code** — Important interfaces, type definitions, API signatures, or schema changes. Use the dark-theme code block pattern. Only include architecturally significant code — not every function.

**Integration points** — How this change connects to existing systems. Where does it hook in? What existing code does it touch? A small SVG diagram of the integration surface can replace paragraphs of description.

**Risks & mitigations** — Table with severity badges (HIGH/MED/LOW). Only include if there are genuine risks — don't fabricate risks to fill a section.

**Open questions** — Things needing decisions before or during implementation. Each should name who can answer it.

**Considerations & rationale** — Why this approach over alternatives. Tradeoffs made. Constraints that shaped the design. Show your thinking.

**Reusability & code quality** — For changes introducing new patterns, abstractions, or shared utilities: what's reusable, how it's tested, what's the maintenance surface.

### What NOT to include

- **Time estimates**: AI consistently misjudges its own speed. A timeline showing phases/sequence is fine; attaching hour or day estimates is not. You may include a timeline without estimates if it helps communicate sequencing.
- **Boilerplate sections**: If a section would just say "N/A" or contain filler, leave it out.
- **Exhaustive file lists**: Show the important files, not every file touched.

## Adapting to the task

The visual vocabulary should match what's being built:

- **Backend/API work**: Lead with data flow diagrams, schemas, API signatures
- **Frontend/UI work**: Lead with mockups, component hierarchy, state flow
- **Infrastructure/DevOps**: Lead with architecture diagrams, deployment flow
- **Refactoring**: Lead with before/after diagrams showing structural change
- **Cross-cutting features**: Lead with a system map showing all touchpoints

Be creative. If a circular dependency diagram explains the problem better than a list, draw one. If a state machine captures the logic better than prose, use SVG. The design system and SVG patterns are a toolkit, not a template — compose them in whatever way best serves the plan.

## HTML structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{Plan title}</title>
  <style>
    /* Plannotator theme defaults — see references/design-system.md */
    :root { /* ... token definitions ... */ }

    /* Base styles */
    /* Component styles */
    /* SVG-specific styles */
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <!-- Sections -->
  </div>
  <script>
    /* Only if interactive elements are needed (collapsible sections, etc.) */
  </script>
</body>
</html>
```

Everything inline. No external CSS, no CDN links, no build step. The file must work when double-clicked in a file manager. When eventually embedded in the Plannotator UI, the `:root` defaults get overridden by the active theme — all the semantic tokens (`--primary`, `--background`, `--border`, etc.) just inherit.

## Quality bar

Before presenting the plan:
- Opens correctly in a browser with no console errors
- Design system tokens used consistently (no hardcoded colors outside `:root`)
- SVG diagrams have readable text at default zoom
- Code snippets use the dark-theme pattern with syntax highlighting
- No section contains filler or boilerplate
- The plan answers "what are we building, why, and how" within 30 seconds of reading
