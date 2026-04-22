/**
 * `comment` subcommand — post a block-level COMMENT annotation.
 *
 * Arg shape:
 *   --block <blockId>  target block (from `read-plan --with-block-ids`)
 *   --text  <body>     comment body
 *   --list-blocks      print the block id → content map as JSON and
 *                      exit without posting (convenience for agents
 *                      that want to pick a block without a separate
 *                      `read-plan` call)
 *
 * Block-level targeting by design: the annotation spans the entire
 * block, so the "selection accuracy" issue that plagues
 * `/api/external-annotations` inline-text matching doesn't apply.
 * V1 agents do NOT attempt sub-range targeting.
 *
 * Exit codes:
 *   0  comment echoed back from server
 *   1  timeout, server rejection, or missing block
 *   2  argv / usage error (propagated from the dispatcher)
 */

import type { RoomAnnotation } from '@plannotator/shared/collab';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import {
  awaitAnnotationEcho,
  awaitInitialSnapshot,
  openAgentSession,
  parseCommonArgs,
  readBoolFlag,
  readStringFlag,
  UsageError,
} from './_lib';

const ECHO_TIMEOUT_MS = 10_000;

export async function runComment(argv: readonly string[]): Promise<number> {
  const args = parseCommonArgs(argv);
  const listOnly = readBoolFlag(args.rest, 'list-blocks');
  const blockId = readStringFlag(args.rest, 'block');
  const text = readStringFlag(args.rest, 'text');

  if (!listOnly) {
    if (!blockId) throw new UsageError('comment: --block is required');
    if (!text) throw new UsageError('comment: --text is required');
  }

  const session = await openAgentSession(args);
  const { client, identity } = session;

  try {
    await awaitInitialSnapshot(client);
  } catch (err) {
    console.error(`[collab-agent] ${(err as Error).message}`);
    client.disconnect('snapshot_timeout');
    return 1;
  }

  const snapshot = client.getState();
  const blocks = parseMarkdownToBlocks(snapshot.planMarkdown);

  if (listOnly) {
    const map = blocks.map(b => ({ id: b.id, type: b.type, content: b.content }));
    process.stdout.write(JSON.stringify(map, null, 2));
    process.stdout.write('\n');
    client.disconnect('list_done');
    await new Promise<void>(r => setTimeout(r, 100));
    return 0;
  }

  // blockId + text are non-null here (enforced above); narrow for TS.
  if (!blockId || !text) {
    // Defensive — should never fire because we validated above.
    client.disconnect('internal_error');
    return 1;
  }

  const block = blocks.find(b => b.id === blockId);
  if (!block) {
    console.error(
      `[collab-agent] unknown --block "${blockId}". Run with --list-blocks to see available ids.`,
    );
    client.disconnect('unknown_block');
    return 1;
  }

  await client.sendPresence(session.initialPresence);

  // V1 room annotation ids are opaque strings; the `ann-agent-`
  // prefix just makes agent-posted rows identifiable in logs /
  // exports without affecting server behavior.
  const annotationId = `ann-agent-${crypto.randomUUID()}`;
  const annotation: RoomAnnotation = {
    id: annotationId,
    blockId: block.id,
    // Block-level target: the whole block is the original text.
    startOffset: 0,
    endOffset: block.content.length,
    type: 'COMMENT',
    text,
    originalText: block.content,
    createdA: Date.now(),
    author: identity,
  };

  // Subscribe BEFORE sending — shared helper awaits echo in
  // canonical state, rejecting on mutation-scope errors or timeout.
  const echo = awaitAnnotationEcho(client, annotationId, ECHO_TIMEOUT_MS);
  await client.sendAnnotationAdd([annotation]);

  try {
    await echo;
  } catch (err) {
    console.error(`[collab-agent] comment rejected: ${(err as Error).message}`);
    client.disconnect('mutation_failed');
    return 1;
  }

  // Success — print the echoed annotation so invoking code can
  // parse the id and attribution.
  const finalState = client.getState();
  const echoed = finalState.annotations.find(a => a.id === annotationId);
  process.stdout.write(JSON.stringify(echoed ?? annotation, null, 2));
  process.stdout.write('\n');

  client.disconnect('comment_done');
  await new Promise<void>(r => setTimeout(r, 100));
  return 0;
}
