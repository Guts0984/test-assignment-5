import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { attachments, cards } from '@kanban/db';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';

import type { Deps } from '../deps';

const BATCH = 100;
const MAX_BATCHES = 20;

export type CleanupResult = { staleUploads: number; deletedCardFiles: number };

type Target = { id: string; objectKey: string };

/**
 * Removes a file and then its row. The object goes first: if the process dies in between, the
 * row is still there and the next run finishes the job (deleting an object that is already gone
 * is not an error). One file that cannot be removed is logged and left for the next run; it
 * never stops the others.
 */
const removeAll = async (deps: Deps, targets: Target[]): Promise<number> => {
  const done: string[] = [];
  for (const target of targets) {
    try {
      await deps.s3.send(
        new DeleteObjectCommand({ Bucket: deps.config.s3.bucket, Key: target.objectKey }),
      );
      done.push(target.id);
    } catch (error) {
      deps.log('could not delete file, will retry', {
        key: target.objectKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (done.length > 0) await deps.db.delete(attachments).where(inArray(attachments.id, done));
  return done.length;
};

/**
 * 1. Uploads that were registered but never completed, once they are older than the limit
 *    (one hour): the assignment's "files without `complete` are deleted after an hour".
 * 2. Files of cards that were deleted. The card rows stay (history); their attachments go.
 */
export const cleanup = async (deps: Deps): Promise<CleanupResult> => {
  const cutoff = new Date(deps.now() - deps.config.timing.uploadMaxAgeMs);
  const result: CleanupResult = { staleUploads: 0, deletedCardFiles: 0 };

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const stale = await deps.db
      .select({ id: attachments.id, objectKey: attachments.objectKey })
      .from(attachments)
      .where(and(eq(attachments.status, 'pending'), lt(attachments.createdAt, cutoff)))
      .limit(BATCH);
    const removed = await removeAll(deps, stale);
    result.staleUploads += removed;
    if (stale.length < BATCH || removed === 0) break;
  }

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const orphaned = await deps.db
      .select({ id: attachments.id, objectKey: attachments.objectKey })
      .from(attachments)
      .innerJoin(cards, eq(cards.id, attachments.cardId))
      .where(isNotNull(cards.deletedAt))
      .limit(BATCH);
    const removed = await removeAll(deps, orphaned);
    result.deletedCardFiles += removed;
    if (orphaned.length < BATCH || removed === 0) break;
  }
  return result;
};
