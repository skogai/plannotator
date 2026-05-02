/**
 * Claude model capability helpers — shared between the adapter (server) and
 * the AI config bar (client) so the rule lives in one place.
 *
 * Runtime-agnostic: no node:* imports, no Bun APIs, no DOM.
 */

/**
 * True for Claude models that default to adaptive extended thinking
 * (Claude decides when and how much to think). Matches Opus 4.7 and above,
 * including future major versions (5.x, 6.x, …).
 *
 * Pre-4.7 Claude models expose a user-facing On/Off toggle in the config
 * bar; this predicate hides that toggle on models where the SDK/runtime
 * already picks the right default.
 */
export function isAdaptiveThinkingDefault(model: string | null | undefined): boolean {
  if (!model) return false;
  // Opus 4.7 through 4.99 — the specific "after Opus 4.7" rule.
  if (/^claude-opus-4-([7-9]|\d{2,})\b/.test(model)) return true;
  // Opus 5+, any minor — future-proofs the rule so new majors don't need
  // a code change to get the adaptive default.
  if (/^claude-opus-([5-9]|\d{2,})-\d+\b/.test(model)) return true;
  return false;
}
