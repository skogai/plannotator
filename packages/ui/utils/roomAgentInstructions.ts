/**
 * Builds the clipboard payload that teaches an external agent (Claude
 * Code, Codex, OpenCode, Junie, etc.) how to join THIS specific
 * Plannotator Live Room as a first-class peer via the
 * `@plannotator/collab-agent` CLI.
 *
 * Parallel to `planAgentInstructions.ts` — same shape, same purpose
 * (a markdown payload the user copies from the room menu and pastes
 * into their agent's prompt), but targets the direct-room path
 * (WebSocket, encrypted) rather than the local /api/external-annotations
 * path (local HTTP, unencrypted).
 *
 * The dynamic values are interpolated at click time:
 *  - `joinUrl` — the full participant URL including the
 *    `#key=<secret>` fragment. This is what the CLI's `--url` flag
 *    takes. Admin URLs work too — the CLI strips `#admin=` before
 *    connecting — but passing the participant URL is cleaner.
 *  - `userIdentity` — the current user's display name. It's
 *    slugified via `toAgentUserSlug` before templating so the
 *    rendered `--user` value is always a valid CLI argument even
 *    when the display name contains spaces, uppercase, or
 *    punctuation (e.g. "Michael Ramos" → "michael-ramos"). Without
 *    this pass, an unquoted `--user Michael Ramos` would truncate
 *    to `Michael` in the shell and agents would silently join
 *    under the wrong identity.
 *
 * Intentionally short. Agents don't read manuals; this is
 * "top-to-bottom in 30 seconds and they can start posting."
 */

import { toAgentUserSlug } from './agentIdentity';

export interface RoomAgentInstructionsInput {
  /** Participant URL — must include `#key=<secret>` fragment. */
  joinUrl: string;
  /** Current user's display name (may contain spaces / caps / punctuation). */
  userIdentity: string;
}

export function buildRoomAgentInstructions(input: RoomAgentInstructionsInput): string {
  const { joinUrl, userIdentity } = input;
  // Escape any characters that would break the markdown's inline-quoted
  // argument values. The CLI itself doesn't care, but the markdown
  // should paste cleanly into any reasonable editor.
  const urlArg = joinUrl.replaceAll('"', '\\"');
  // Slugify before templating so the rendered `--user` value is
  // always shell-safe and CLI-valid. See the module docstring for
  // why this matters (unquoted shell splitting / constructAgentIdentity
  // charset).
  const userArg = toAgentUserSlug(userIdentity);
  return `# Plannotator Live Room — Agent Join Instructions

You're being invited to join a live, encrypted review session hosted by a Plannotator user. You participate as a first-class peer — read the plan, read annotations, post comments, and remain visible on participants' screens via a distinguished agent marker.

## Your identity

The user has already chosen an identity for you. Pass it exactly as the \`--user\` value on every CLI invocation:

- \`--user ${userArg}\`
- \`--type <your kind>\` — one of: \`claude\`, \`codex\`, \`opencode\`, \`junie\`, \`other\`. Pick whichever describes you. Use \`other\` if none apply.

The CLI assembles your full room identity as \`${userArg}-agent-<type>\`. That's what the user sees in their avatar row and above your cursor, with a \`⚙\` marker indicating agent.

## Joining this room

Every subcommand takes \`--url\`, \`--user\`, \`--type\`. This is the URL for THIS session:

\`\`\`
${joinUrl}
\`\`\`

## What to do right now

**Don't wait for the user to give you a specific task.** The room is being shared in front of an audience and they expect to see agent activity within seconds of the link landing. Your default first action is to run \`demo\`:

\`\`\`sh
bun run agent:run demo \\
  --url "${urlArg}" \\
  --user ${userArg} --type claude \\
  --duration 120
\`\`\`

\`demo\` walks your cursor through every heading in document order, anchors at each heading with a randomized horizontal offset (so parallel agents don't stack on the same pixel), pauses 3–6 s, and posts a block-level comment at each stop. Takes about two minutes and produces immediately-visible activity for the audience. The \`⚙\` marker next to your name makes it obvious you're an agent, not a human peer.

After \`demo\` finishes (or in parallel if you can manage it), follow up with **one or two thoughtful observations** about substantive blocks — real comments on performance targets, design tradeoffs, concrete claims, anything where you have an opinion worth stating. Use \`comment\` for those. Templated "[demo] reviewing X" text is enough to prove you're there; a genuine observation is what proves you actually read the plan.

If the user has given you a specific task instead (e.g. "review the infrastructure section for holes"), drop this default and follow their direction.

## Reference — reading the plan and peers

From the Plannotator repo root (the CLI is a workspace package under \`apps/collab-agent/\`):

\`\`\`sh
# Read the plan with block ids (you need the block ids to comment)
bun run agent:run read-plan --with-block-ids \\
  --url "${urlArg}" \\
  --user ${userArg} --type claude

# See existing annotations
bun run agent:run read-annotations \\
  --url "${urlArg}" \\
  --user ${userArg} --type claude

# See peers who've emitted presence recently
bun run agent:run read-presence \\
  --url "${urlArg}" \\
  --user ${userArg} --type claude
\`\`\`

\`read-presence\` is "recent emitters," not a participant roster — connected-but-idle peers won't appear.

## Posting a comment

Block-level only in V1. You target an entire block; the comment attaches to that block's content. Inline text-range targeting is not supported here (use prose inside your \`--text\` to reference specific wording).

\`\`\`sh
bun run agent:run comment \\
  --url "${urlArg}" \\
  --user ${userArg} --type claude \\
  --block <blockId> \\
  --text "Your comment text."
\`\`\`

Need to see the blocks without running \`read-plan\`?

\`\`\`sh
bun run agent:run comment --list-blocks \\
  --url "${urlArg}" \\
  --user ${userArg} --type claude
\`\`\`

\`comment\` waits for the server echo before exiting. Exit 0 = the comment appeared in everyone's view. Exit 1 = timeout or server rejection (e.g. the room is locked). Exit 2 = argv error.

## Staying visible while you work

\`read-*\` and \`comment\` are one-shots — you flash into the avatar row during the call and disappear. To be continuously visible (recommended when doing multi-step work so the user sees you "thinking"):

\`\`\`sh
bun run agent:run join \\
  --url "${urlArg}" \\
  --user ${userArg} --type claude
\`\`\`

Runs until SIGINT. Heartbeats presence every 10s so you stay in the avatar row. Streams room events to stdout as NDJSON — you can tail it while running other subcommands in other shells.

## Demo mode — flags reference

\`demo\` is covered above under "What to do right now" — this section is the flag reference.

- \`--duration <sec>\` — total wall time across all headings (default 120). Per-heading pause is clamped to 3–6 s regardless.
- \`--comment-template <str>\` — body for each posted comment. \`{heading}\` and \`{level}\` are substituted. Default: \`"[demo] reviewing {heading}"\`.
- \`--dry-run\` — walk the cursor without posting comments. Use this if the user explicitly wants a quiet cursor-only showcase.

Demo confirms each comment's echo per heading and exits non-zero if any comment failed to land (e.g. room locked mid-tour). Streams \`demo.start\`, \`demo.visit\`, \`demo.comment\`, \`demo.comment.failed\`, and \`demo.end\` events as NDJSON so an invoking script can track progress.

## Rules and limits

- **No admin actions.** You cannot lock, unlock, or delete the room. If the URL contained \`#admin=\`, the CLI strips it and warns; you join as a regular participant.
- **No image attachments.** V1 room annotations are text only.
- **Server-authoritative.** Your post is not final until the server echoes it back. \`comment\` waits; \`demo\` tracks per-heading success. Don't assume local intent landed.
- **Block-level only.** Do NOT attempt to select a sub-range of text for annotation anchoring. That path has known selection-accuracy issues. Quote specific wording inside your comment body if it matters.

## Troubleshooting

- \`Missing --url\` / \`Missing --user\` / \`Missing --type\` — add the flag.
- \`Timed out waiting for snapshot\` — the URL parsed but the room service is unreachable. Check you can open the URL in a browser.
- \`unknown --block\` — that block id isn't in the current plan. Run \`comment --list-blocks\` to see the valid set.
- \`<code>: <message>\` on a comment — the server rejected the op. Most common: \`room_locked\` (an admin locked the room; read-only). Wait and retry, or move on.
`;
}
