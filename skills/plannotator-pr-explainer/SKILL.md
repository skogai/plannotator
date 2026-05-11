---
name: plannotator-pr-explainer
description: >
  Generate rich, standalone HTML explainer documents for pull requests and code changes.
  Produces visual walkthroughs with inline diffs, SVG architecture diagrams, file-by-file
  commentary, risk assessments, before/after comparisons, and "where to focus" guidance
  for reviewers. Use when the user asks to explain a PR, write up code changes for review,
  create a PR description, document what a branch does, or generate a reviewer guide. Also
  trigger when the user says "explain this diff", "write a PR summary", "help reviewers
  understand this", or wants to visualize what changed and why. If the user has a complex
  PR with many files, this skill produces something far more useful than a markdown summary.
---

# PR Explainer Generator

You produce single-file, zero-dependency HTML documents that make pull requests genuinely understandable. Not another wall-of-text PR description — a spatial, visual walkthrough with inline diffs, architecture diagrams showing what changed, risk-graded file cards, and clear guidance on where reviewers should focus.

The explainer uses the Plannotator theme system for standalone viewing and future embedding in the Plannotator review UI.

## When to generate

Create an HTML PR explainer when:
- A PR touches 3+ files and the "why" isn't obvious from the diff alone
- Architecture or data flow changes that benefit from a diagram
- The PR has mixed risk levels (some files need careful review, others are mechanical)
- Before/after behavior changes that are easier to show than describe
- The user wants to make a reviewer's job easier

For a one-file typo fix, a plain text PR description is fine.

## How to use this skill

1. Read `references/pr-components.md` for PR-specific component patterns (diffs, comments, risk maps, file tours)
2. Read `../plannotator-visual-plan/references/design-system.md` for the shared Plannotator design system tokens
3. Read `../plannotator-visual-plan/references/svg-patterns.md` for SVG diagram building blocks
4. Analyze the diff (use `git diff`, `git log`, or the user's provided changes)
5. Generate the HTML file and save it
6. Tell the user where the file is

## Document anatomy

Every PR explainer needs a header, a summary, and at least one substantive section. Beyond that, adapt to what serves the PR.

### Required: Header

- **Eyebrow label**: repo context, mono, small, uppercase (`--muted-foreground`)
- **PR title**: display font, large — what does this PR do in one line?
- **Meta strip**: file count, lines added/removed, branch info, author — all in mono
- **Prompt box** (optional): the original task/brief that motivated the PR

### Required: TL;DR

A bordered card with clay left accent summarizing in 2-3 sentences what this PR does and why. Reviewers who read nothing else should understand the gist from this.

### Section menu — pick what fits

**Architecture / data flow changes** — SVG diagram showing what changed structurally. Highlight new components with `--primary` stroke, removed ones with `--destructive`. Show the before and after if the architecture shifted. See `../plannotator-visual-plan/references/svg-patterns.md`.

**Before / after comparison** — Two-column grid showing old behavior vs. new behavior. The "after" column gets a `--success` border. Can show UI screenshots, API responses, data shapes, or behavioral descriptions.

**File tour** — Collapsible file cards grouped by risk level. Each card has:
- File path in mono + badge (NEW/MOD/DEL) + line stats (+N/-M)
- A "why" paragraph explaining the purpose of changes in this file
- Inline diff showing the important hunks (not necessarily the full diff)
- Optional review comments attached to specific lines

High-risk files shown expanded; safe files collapsed in `<details>`.

**Risk map** — Visual chips or cards showing each file's risk level at a glance. Three tiers:
- **Attention** (`--destructive` tint): breaking changes, security-sensitive, needs careful review
- **Medium** (`--warning` tint): logic changes, moderate complexity
- **Safe** (`--success` tint): mechanical changes, renames, imports

**Where to focus** — Numbered callout cards telling reviewers exactly what to look at and why. Each item names a file/function and describes the concern. "Look at X because Y."

**Key code** — Important new interfaces, type definitions, or API signatures. Use the dark-theme code block pattern. Only include architecturally significant code.

**Test plan** — Checkbox-style checklist of manual verification steps. Helps reviewers and QA understand what was tested and what to verify.

**Open questions** — Things still uncertain. Each question names who should weigh in.

### What NOT to include

- **Time estimates**: not relevant for a PR explainer
- **Every hunk of every file**: show the important changes, not the mechanical ones
- **Filler sections**: if the PR is straightforward, fewer sections is better

## Adapting to the PR

The visual vocabulary should match the nature of changes:

- **Feature PRs**: Lead with architecture diagram, file tour, and before/after
- **Bug fixes**: Lead with the root cause explanation, the fix, and a test plan
- **Refactors**: Lead with before/after architecture diagrams and the structural change
- **Security fixes**: Lead with risk assessment, the vulnerability, and the mitigation
- **Dependency updates**: Lead with what changed, what could break, and a test plan

Be creative with diagrams. If a sequence diagram explains the bug better than prose, draw one. If a state machine shows the race condition, use SVG.

## HTML structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR: {title}</title>
  <style>
    /* Plannotator theme defaults — see plannotator-visual-plan/references/design-system.md */
    :root { /* ... */ }
    /* Base + component styles */
    /* Diff rendering styles */
    /* PR-specific component styles — see references/pr-components.md */
  </style>
</head>
<body>
  <div class="container">
    <!-- Header + TL;DR -->
    <!-- Sections -->
  </div>
  <script>
    /* Only if interactive elements needed (risk map jump links, accordion, etc.) */
  </script>
</body>
</html>
```

Everything inline. No external dependencies. The file must work when opened directly in a browser.

## Quality bar

Before presenting:
- Opens correctly in a browser with no console errors
- A reviewer reading only the TL;DR and risk map knows what to focus on
- Diffs use proper add/del coloring with line numbers
- Architecture diagrams have readable text at default zoom
- No section contains filler — every section earns its place
- Risk levels are honest (don't mark everything as "safe")
