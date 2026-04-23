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
 * Implementation: walks the raw string once, preserving whitespace runs and
 * non-whitespace tokens as separate segments. Only `--gate` / `--json`
 * tokens (whole-word match) plus one adjacent whitespace run are removed.
 * This keeps double-spaces and tabs inside file paths intact — which
 * matches the pre-PR behavior on `main`, where OpenCode and Pi passed
 * the raw args string straight through to the filesystem resolver.
 *
 * Remaining edge: if a path literally contains `--gate` or `--json` as a
 * standalone whitespace-separated token (e.g. `"Feature --gate spec.md"`),
 * that token is stripped. Supporting this would need shell-style quoting,
 * which isn't worth the complexity for a vanishingly rare naming pattern.
 */

export interface ParsedAnnotateArgs {
  filePath: string;
  gate: boolean;
  json: boolean;
}

type Segment = { type: "ws" | "tok"; text: string };

export function parseAnnotateArgs(raw: string): ParsedAnnotateArgs {
  const s = (raw ?? "").trim();
  let gate = false;
  let json = false;

  const segments: Segment[] = [];
  for (let i = 0; i < s.length;) {
    const isWs = /\s/.test(s[i]);
    const start = i;
    while (i < s.length && /\s/.test(s[i]) === isWs) i++;
    segments.push({ type: isWs ? "ws" : "tok", text: s.slice(start, i) });
  }

  const keep = segments.map(() => true);
  for (let j = 0; j < segments.length; j++) {
    const seg = segments[j];
    if (seg.type !== "tok") continue;
    if (seg.text !== "--gate" && seg.text !== "--json") continue;

    if (seg.text === "--gate") gate = true;
    else json = true;
    keep[j] = false;

    // Drop one adjacent whitespace run so removed flags don't leave dangling
    // spaces. Prefer trailing whitespace; fall back to leading if at the end.
    if (j + 1 < segments.length && segments[j + 1].type === "ws") {
      keep[j + 1] = false;
    } else if (j > 0 && segments[j - 1].type === "ws") {
      keep[j - 1] = false;
    }
  }

  // Trim covers the case where two adjacent flags (`... --gate --json`)
  // both claim the single whitespace between them, leaving a trailing space
  // after the kept token.
  const filePath = segments
    .filter((_, j) => keep[j])
    .map((seg) => seg.text)
    .join("")
    .trim()
    .replace(/^@/, "");

  return { filePath, gate, json };
}
