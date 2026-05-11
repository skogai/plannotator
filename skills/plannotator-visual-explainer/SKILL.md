---
name: plannotator-visual-explainer
description: >
  Generate beautiful, self-contained HTML visualizations themed with Plannotator's design system.
  Wraps the visual-explainer skill by nicobailon with Plannotator theme token integration. Use for
  architecture diagrams, diff reviews, plan reviews, data tables, slide decks, project recaps, or
  any visual explanation of technical concepts — whenever you want output styled consistently with
  Plannotator's UI and compatible with --render-html annotation. Triggers on the same prompts as
  visual-explainer (diagrams, architecture overviews, visual plans, diff reviews) but produces
  output that uses Plannotator CSS custom properties instead of custom palettes.
---

# Plannotator Visual Explainer

This skill wraps [visual-explainer](https://github.com/nicobailon/visual-explainer) by Nico Bailon with Plannotator theme integration. You follow visual-explainer's workflow, references, templates, and anti-slop rules — the only difference is the color and typography layer.

## Setup

Before generating, ensure `visual-explainer` is available:

1. Check if the skill exists at any of these paths (in order):
   - `~/.claude/skills/visual-explainer/SKILL.md`
   - `~/.agents/skills/visual-explainer/SKILL.md`
   - `~/.codex/skills/visual-explainer/SKILL.md`

2. If not found, install it:
   ```bash
   npx skills add nicobailon/visual-explainer -g --yes
   ```

3. Read the visual-explainer `SKILL.md` to absorb its full workflow, diagram type routing, structure rules, and anti-slop guidelines. Read its `references/` and `templates/` as directed by its workflow.

## Theme Override

The single override: instead of visual-explainer's custom palettes (terracotta/sage, teal/slate, etc.) and font pairings (DM Sans, Instrument Serif, etc.), use Plannotator's semantic theme tokens.

Read `references/theme-override.md` for the exact CSS custom properties to use. Apply these **after** reading visual-explainer's references — they replace only the color and typography layer, not the structural patterns, component layouts, or anti-slop rules.

## Workflow

1. **Read** visual-explainer's SKILL.md (full workflow, diagram types, quality checks)
2. **Read** the relevant visual-explainer references and templates for your content type
3. **Read** `references/theme-override.md` from this skill
4. **Generate** following visual-explainer's structure, component classes, and rules, but with Plannotator tokens. Use Nico's component classes (`.ve-card`, `.ve-card--hero`, `.kpi-card`, `.pipeline`, etc.) — do NOT fall back to other pattern sets.
5. **Deliver** via Plannotator's annotation UI:

**If the output is a plan or proposal** (something the user should approve/deny):
```bash
plannotator annotate <file> --render-html --gate
```

**If the output is a visual explainer, diagram, or informational page:**
```bash
plannotator annotate <file> --render-html
```

Always use `--render-html` so the HTML renders as-is in the Plannotator UI with theme inheritance and annotation support. Do NOT use `open` or `xdg-open` directly.

## What visual-explainer provides (do not duplicate)

All of these come from visual-explainer — read them there, don't reinvent them:
- Diagram type routing (architecture, flowchart, sequence, ER, state, mind map, etc.)
- Mermaid integration (theming, zoom controls, scaling, layout direction)
- CSS structural patterns (cards, grids, connectors, depth tiers, collapsibles)
- Slide deck mode (viewport-snapping presentations)
- Data table patterns (sticky headers, status indicators, responsive scrolling)
- Anti-slop rules (forbidden fonts, colors, animations, patterns)
- Quality checks (squint test, swap test, overflow protection)
- Animation guidelines (staggered entrance, reduced-motion support)

## What this skill adds

- Plannotator theme tokens (colors, typography, radii) that integrate with the 30+ Plannotator themes
- Compatibility with `--render-html` annotation mode (theme tokens inherited when embedded)
- Consistent styling with the Plannotator UI across all visual outputs
