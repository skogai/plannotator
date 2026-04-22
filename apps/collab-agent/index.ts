/**
 * @plannotator/collab-agent — CLI entry point.
 *
 * Dispatches to a subcommand under `./subcommands/`. Each subcommand
 * parses its own argv (via the shared helpers in `_lib.ts`),
 * manages its own connection lifecycle, and returns an exit code.
 *
 * Usage:
 *   bun run apps/collab-agent/index.ts <subcommand> --url <url> --user <name> --type <kind> [...]
 *
 * Subcommands:
 *   join               connect and stay online with heartbeat presence
 *   read-plan          print decrypted plan markdown (add --with-block-ids for block markers)
 *   read-annotations   print current annotations as JSON
 *   read-presence      print recent peer presence (not a roster)
 *   comment            post a block-level comment annotation
 *   demo               walk headings and leave comments at each
 *
 * Exit codes:
 *   0  success
 *   1  runtime error (connect timeout, server rejection, ...)
 *   2  argument / usage error
 */

import { runJoin } from './subcommands/join';
import { runReadPlan } from './subcommands/read-plan';
import { runReadAnnotations } from './subcommands/read-annotations';
import { runReadPresence } from './subcommands/read-presence';
import { runComment } from './subcommands/comment';
import { runDemo } from './subcommands/demo';
import { UsageError } from './subcommands/_lib';

const HELP = `plannotator collab-agent — join Live Rooms as an AI agent

Usage:
  bun run apps/collab-agent/index.ts <subcommand> [options]

Subcommands:
  join               connect and stay online with heartbeat presence
  read-plan          print decrypted plan markdown
                     (add --with-block-ids for block markers)
  read-annotations   print current annotations as JSON
  read-presence      print recent peer presence (not a participant roster)
  comment            post a block-level comment annotation
                     (--block <id> --text <body>, or --list-blocks
                     to print available block ids + exit)
  demo               walk heading blocks in order, anchor the cursor
                     to each, and post a comment per heading
                     (--duration <sec>, --comment-template <str>,
                     --dry-run to skip posting)

Common flags (every subcommand):
  --url <url>        full room URL including #key=... fragment
  --user <name>      lowercase alnum + dashes; becomes <user>-agent-<type>
  --type <kind>      claude | codex | opencode | junie | other

Examples:
  bun run apps/collab-agent/index.ts read-plan \\
    --url "http://localhost:8787/c/abc123#key=..." \\
    --user alice --type claude

  bun run apps/collab-agent/index.ts join \\
    --url "https://room.plannotator.ai/c/xyz#key=..." \\
    --user swift-falcon-tater --type codex
`;

type Subcommand = (argv: readonly string[]) => Promise<number>;

const SUBCOMMANDS: Record<string, Subcommand> = {
  join: runJoin,
  'read-plan': runReadPlan,
  'read-annotations': runReadAnnotations,
  'read-presence': runReadPresence,
  comment: runComment,
  demo: runDemo,
};

async function main(argv: readonly string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    return 0;
  }

  const runner = SUBCOMMANDS[sub];
  if (!runner) {
    console.error(`collab-agent: unknown subcommand "${sub}"`);
    console.error('Run with --help for the subcommand list.');
    return 2;
  }

  try {
    return await runner(argv.slice(1));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`collab-agent: ${err.message}`);
      console.error('Run with --help for usage.');
      return 2;
    }
    console.error(`collab-agent: ${(err as Error).message ?? String(err)}`);
    return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
