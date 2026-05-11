# Loose List Items (Issue #704)

This fixture demonstrates the bullet point indentation bug. In standard markdown, when a list item has continuation content separated by a blank line but indented under the bullet, that content belongs to the bullet and should render indented beneath it. Right now the parser treats those continuation paragraphs as standalone top-level blocks, so they render flush-left with no visual connection to the bullet above them.

Look at the bullets below. The paragraphs and inline code after each bullet header should be indented under the bullet — visually nested as child content. Instead they appear at the same level as regular paragraphs, breaking the structure.

---

## Bug: Bullet points with blank-line-separated body text

Combine batter consistency, cooking temperature, topping selection, and timing in a single breakfast session.

- **Waffles**

  The following method prepares a waffle while enforcing all recommended crispiness checks:

  `BatterMixer.run({ mode: "waffle", temp: 400 })`

- **Pancakes**

  Pancake preparation differs from waffles in several ways: batter is poured sequentially (there's no waffle iron), flip timing needs explicit handling, and the `BubbleStream` must be observed before advancing to the next pancake.

  `GriddleSession.start({ flipDetection: true })`

The two paragraphs and code lines after each bullet above should be indented under their respective bullet, not rendered flush-left as separate paragraphs.

---

## Bug: Same problem with numbered lists

1. **Preheat the griddle**

   Set temperature to 375 and wait for the indicator light. The surface should be evenly heated before proceeding.

2. **Pour the batter**

   Use a quarter-cup measure for consistent sizing. Pour from the center and let it spread naturally.

3. **Watch for bubbles**

   When bubbles form across the surface and the edges look set, flip once. Do not press down on the pancake.

Same issue — the description paragraphs after each numbered item should be indented under their number, not floating as standalone text.

---

## Bug: Nested lists inside loose items

- **Breakfast items**

  These are the main categories:

  - Waffles
  - Pancakes
  - French toast

- **Lunch items**

  Served after 11am:

  - Sandwiches
  - Salads

Here the "These are the main categories:" text and the sub-list should both be indented under their parent bullet.

---

## Control: Tight lists (these should already work)

- This is a tight list item with no blank line separation
- Another tight item
- A third tight item

These tight items have no blank-line gaps, so the parser already handles them correctly. Compare the rendering above to the broken loose lists to see the difference.
