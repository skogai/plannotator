/**
 * Integration tests for the collab client runtime against a live wrangler dev Worker.
 *
 * Gated by SMOKE_BASE_URL env var. Skipped when unset.
 *
 * Usage:
 *   cd apps/room-service && bunx wrangler dev
 *   # In another terminal:
 *   SMOKE_BASE_URL=http://localhost:8787 bun test packages/shared/collab/client-runtime/integration.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { createRoom, joinRoom } from './index';
import type { CollabRoomClient } from './client';
import type { RoomSnapshot } from '../types';

const BASE_URL = process.env.SMOKE_BASE_URL;
const shouldRun = !!BASE_URL;

const USER_A = { id: 'user-a', name: 'alice', color: '#f00' };
const USER_B = { id: 'user-b', name: 'bob', color: '#0f0' };

const describeFn = shouldRun ? describe : describe.skip;

function safeDisconnect(client: CollabRoomClient | null): void {
  if (!client) return;
  try { client.disconnect(); } catch { /* ignore — best-effort cleanup */ }
}

describeFn('CollabRoomClient integration (against wrangler dev)', () => {
  test('createRoom, two clients exchange event + presence, admin delete', async () => {
    let creator: CollabRoomClient | null = null;
    let participant: CollabRoomClient | null = null;
    let adminClient: CollabRoomClient | null = null;

    try {
      const snapshot: RoomSnapshot = {
        versionId: 'v1',
        planMarkdown: '# Integration test',
        annotations: [],
      };

      // Creator creates the room and connects
      const created = await createRoom({
        baseUrl: BASE_URL!,
        initialSnapshot: snapshot,
        user: USER_A,
      });
      creator = created.client;
      const { joinUrl, adminUrl } = created;
      await creator.connect();
      expect(creator.getState().connectionStatus).toBe('authenticated');

      // Second participant joins via joinUrl
      participant = await joinRoom({
        url: joinUrl,
        user: USER_B,
        autoConnect: true,
      });
      expect(participant.getState().connectionStatus).toBe('authenticated');

      // Creator sends an annotation — participant should see it
      const ann = {
        id: 'int-ann-1',
        blockId: 'b1',
        startOffset: 0,
        endOffset: 5,
        type: 'COMMENT' as const,
        originalText: 'hello',
        createdA: Date.now(),
        text: 'from creator',
      };
      await creator.sendAnnotationAdd([ann]);
      await new Promise(r => setTimeout(r, 500));
      expect(participant.getState().annotations.map(a => a.id)).toContain('int-ann-1');

      // Admin (creator) joins via adminUrl to exercise admin capability
      adminClient = await joinRoom({ url: adminUrl, user: USER_A, autoConnect: true });
      expect(adminClient.getState().hasAdminCapability).toBe(true);

      // Admin deletes the room
      await adminClient.deleteRoom();
      await new Promise(r => setTimeout(r, 500));
      expect(adminClient.getState().roomUnavailable).toBe(true);
    } finally {
      safeDisconnect(creator);
      safeDisconnect(participant);
      safeDisconnect(adminClient);
    }
  }, 30_000);

  test('manual reconnect replays events missed while a participant was offline', async () => {
    // NOTE: this exercises the MANUAL reconnect path — participant calls
    // disconnect() and then connect() again. The automatic network-drop
    // reconnect path (auto-reconnect timer with preserved seq) is covered by
    // the unit-test socket lifecycle suite; a live test of that path would
    // require simulating a server-side socket close, which wrangler dev does
    // not cleanly expose.
    let creator: CollabRoomClient | null = null;
    let participant: CollabRoomClient | null = null;
    // Admin URL captured for server-side cleanup in finally. If SMOKE_BASE_URL
    // ever points at a shared/staging room-service, leaving rooms around until
    // expiry is noisy; deleting explicitly keeps the target clean.
    let adminUrl: string | null = null;

    try {
      const snapshot: RoomSnapshot = {
        versionId: 'v1',
        planMarkdown: '# Reconnect replay test',
        annotations: [],
      };

      const created = await createRoom({
        baseUrl: BASE_URL!,
        initialSnapshot: snapshot,
        user: USER_A,
      });
      creator = created.client;
      adminUrl = created.adminUrl;
      await creator.connect();
      expect(creator.getState().connectionStatus).toBe('authenticated');

      participant = await joinRoom({
        url: created.joinUrl,
        user: USER_B,
        autoConnect: true,
      });
      expect(participant.getState().connectionStatus).toBe('authenticated');

      // Both clients see an initial annotation round-trip (baseline sanity).
      const firstAnn = {
        id: 'replay-ann-1',
        blockId: 'b1',
        startOffset: 0,
        endOffset: 5,
        type: 'COMMENT' as const,
        originalText: 'hello',
        createdA: Date.now(),
        text: 'before drop',
      };
      await creator.sendAnnotationAdd([firstAnn]);
      await waitFor(() =>
        participant!.getState().annotations.some(a => a.id === firstAnn.id),
        3000,
      );
      const seqAtDisconnect = participant.getState().seq;
      expect(seqAtDisconnect).toBeGreaterThan(0);

      // Participant disconnects. While offline, the creator makes two more ops.
      participant.disconnect();
      expect(participant.getState().connectionStatus).toBe('closed');

      const missedAnn1 = {
        id: 'replay-ann-missed-1',
        blockId: 'b1',
        startOffset: 10,
        endOffset: 15,
        type: 'COMMENT' as const,
        originalText: 'missed-1',
        createdA: Date.now(),
        text: 'sent while offline',
      };
      const missedAnn2 = {
        id: 'replay-ann-missed-2',
        blockId: 'b1',
        startOffset: 20,
        endOffset: 25,
        type: 'COMMENT' as const,
        originalText: 'missed-2',
        createdA: Date.now(),
        text: 'also sent while offline',
      };
      await creator.sendAnnotationAdd([missedAnn1]);
      await creator.sendAnnotationAdd([missedAnn2]);
      await waitFor(() => {
        const ids = creator!.getState().annotations.map(a => a.id);
        return ids.includes(missedAnn1.id) && ids.includes(missedAnn2.id);
      }, 3000);

      // Participant reconnects. The client sends its preserved seq as lastSeq
      // and the server replays the missed events.
      await participant.connect();
      expect(participant.getState().connectionStatus).toBe('authenticated');

      await waitFor(() => {
        const ids = participant!.getState().annotations.map(a => a.id);
        return ids.includes(missedAnn1.id) && ids.includes(missedAnn2.id);
      }, 5000);

      // Participant's seq must have advanced past seqAtDisconnect.
      expect(participant.getState().seq).toBeGreaterThan(seqAtDisconnect);

      // And the baseline annotation is still there.
      expect(participant.getState().annotations.map(a => a.id)).toContain(firstAnn.id);
    } finally {
      // Server-side cleanup: delete the room so shared/staging SMOKE_BASE_URL
      // targets don't accumulate smoke rooms until expiry. Disconnect the
      // participant first — delete will close remaining sockets, but a clean
      // pre-disconnect avoids noisy AdminInterruptedError on the participant.
      safeDisconnect(participant);
      if (adminUrl) {
        let adminClient: CollabRoomClient | null = null;
        try {
          adminClient = await joinRoom({ url: adminUrl, user: USER_A, autoConnect: true });
          await adminClient.deleteRoom();
        } catch { /* ignore cleanup errors */ }
        finally { safeDisconnect(adminClient); }
      }
      safeDisconnect(creator);
    }
  }, 30_000);
});

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
}
