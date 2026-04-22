/**
 * Image stripping for converting Annotation objects into RoomAnnotation.
 *
 * Uses a generic approach to avoid importing Annotation from @plannotator/ui.
 * Callers in packages/ui or packages/editor pass Annotation values; this
 * helper strips the images field.
 */

/** Strip the images field from an annotation-like object. */
export function toRoomAnnotation<T extends { images?: unknown }>(
  annotation: T,
): Omit<T, 'images'> {
  const { images: _, ...rest } = annotation;
  return rest;
}

/**
 * Batch conversion. Module-private — the public entry for room-bound
 * annotations is `stripRoomAnnotationImages`, which returns both the
 * `clean` batch and the total `strippedCount`. Direct callers should
 * use `toRoomAnnotation` for a single annotation or
 * `stripRoomAnnotationImages` for a batch; this internal helper is
 * intentionally not exported so the count reporting stays centralized.
 */
function toRoomAnnotations<T extends { images?: unknown }>(
  annotations: T[],
): Omit<T, 'images'>[] {
  return annotations.map(toRoomAnnotation);
}

/**
 * Batch conversion + count of how many local items will NOT travel to
 * the room.
 *
 * Used by the creator flow to decide whether to show an "N items
 * stripped" notice before creating a room. The count combines:
 *   - annotations with a non-empty `images` array (per-annotation
 *     attachments — only `clean` carries forward), and
 *   - the length of an optional `globalAttachments` list (separate
 *     top-level attachments; room snapshots don't carry these at all).
 *
 * An annotation counts as image-bearing only if `images` is a non-empty
 * array — a bare `undefined` field or `[]` does not trigger the notice.
 * The notice text, the URL `&stripped=N` handoff, and any future
 * analytics all read from `strippedCount`, so there's exactly one
 * definition of "how many images won't travel".
 */
export function stripRoomAnnotationImages<T extends { images?: unknown }>(
  annotations: T[],
  globalAttachments: readonly unknown[] = [],
): { clean: Omit<T, 'images'>[]; strippedCount: number } {
  let strippedCount = globalAttachments.length;
  for (const a of annotations) {
    const imgs = (a as { images?: unknown }).images;
    if (Array.isArray(imgs) && imgs.length > 0) strippedCount++;
  }
  return { clean: toRoomAnnotations(annotations), strippedCount };
}
