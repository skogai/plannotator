/**
 * Parse CLI-style args arriving as a single whitespace-delimited string.
 *
 * Extracts the `--gate` and `--json` flags (issue #570) from the remainder,
 * which is treated as the target path. Leading `@` is stripped to match the
 * Claude Code path-arg convention used in apps/hook/server/index.ts.
 *
 * Used by the OpenCode plugin and Pi extension, where the whole args string
 * arrives pre-joined from the harness slash-command dispatcher. The Claude
 * Code binary parses argv directly with indexOf/splice and does not use
 * this helper.
 *
 * Known limitation: this is a naive whitespace tokenizer. Paths that contain
 * consecutive whitespace (double-space, tabs) get their spacing collapsed,
 * and paths that literally contain `--gate`/`--json` as a whitespace-separated
 * substring (e.g. `"Feature --gate spec.md"`) have that token stripped. A
 * fuller shell-style tokenizer with quoting support would avoid both, but
 * the tradeoff isn't worth it — dev-context paths with those shapes are
 * vanishingly rare.
 */

export interface ParsedAnnotateArgs {
  filePath: string;
  gate: boolean;
  json: boolean;
}

export function parseAnnotateArgs(raw: string): ParsedAnnotateArgs {
  const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  const gate = tokens.includes("--gate");
  const json = tokens.includes("--json");
  const filePath = tokens
    .filter((t) => t !== "--gate" && t !== "--json")
    .join(" ")
    .replace(/^@/, "");
  return { filePath, gate, json };
}
