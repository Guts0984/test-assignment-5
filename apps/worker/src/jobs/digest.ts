import {
  commentMentions,
  comments,
  cards,
  emailDeliveries,
  users,
  workspaceMembers,
  type Transaction,
} from '@kanban/db';
import { and, asc, eq, inArray, isNull, lte, max, min, sql } from 'drizzle-orm';

import type { Deps } from '../deps';
import { excerptOf } from '../mail/render';
import { digestJobOptions } from '../queues';

/**
 * A mention may only be reported to someone who is a member of the comment's workspace NOW, and
 * has been one since before the mention was made. A removed member loses access at once, so the
 * comment text and card titles of that workspace must not reach their mailbox; and when they are
 * invited back later, mentions from before the new membership stay out (a new membership is a new
 * row, so its `createdAt` is the moment they came back). Filtered mentions are simply never
 * claimed: nothing is scheduled or sent for them, and no state has to be kept about them.
 */
const stillMember = and(
  eq(workspaceMembers.workspaceId, comments.workspaceId),
  eq(workspaceMembers.userId, commentMentions.userId),
  lte(workspaceMembers.createdAt, commentMentions.createdAt),
);

export type DigestResult = 'created' | 'too_early' | 'nothing';

/**
 * Looks for users with mentions that no email covers yet, and schedules ONE digest job per user.
 *
 * When the job runs: `max(first unclaimed mention + collect window, last digest + 15 minutes)`.
 * The window lets a burst of mentions become one email; the second term is the "at most one email
 * per user every 15 minutes" rule. The job id is per user, so scanning again never duplicates it.
 */
export const scanMentions = async (deps: Deps): Promise<number> => {
  const waiting = await deps.db
    .select({ userId: commentMentions.userId, first: min(commentMentions.createdAt) })
    .from(commentMentions)
    .innerJoin(comments, eq(comments.id, commentMentions.commentId))
    .innerJoin(cards, and(eq(cards.id, comments.cardId), isNull(cards.deletedAt)))
    .innerJoin(workspaceMembers, stillMember)
    .where(isNull(commentMentions.deliveryId))
    .groupBy(commentMentions.userId);
  if (waiting.length === 0) return 0;

  const last = await deps.db
    .select({ userId: emailDeliveries.userId, at: max(emailDeliveries.createdAt) })
    .from(emailDeliveries)
    .where(
      and(
        eq(emailDeliveries.kind, 'mention_digest'),
        inArray(
          emailDeliveries.userId,
          waiting.map((row) => row.userId),
        ),
      ),
    )
    .groupBy(emailDeliveries.userId);
  const lastAt = new Map(last.map((row) => [row.userId, row.at?.getTime()]));

  const { digestCollectMs, digestMinIntervalMs } = deps.config.timing;
  await Promise.all(
    waiting.map((row) => {
      const earliest = Math.max(
        (row.first?.getTime() ?? deps.now()) + digestCollectMs,
        (lastAt.get(row.userId) ?? 0) + digestMinIntervalMs,
      );
      return deps.queues.digest.add(
        'digest',
        { userId: row.userId },
        digestJobOptions(row.userId, earliest - deps.now()),
      );
    }),
  );
  return waiting.length;
};

const lockUser = (tx: Transaction, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`digest:${userId}`}, 0))`);

/**
 * Turns ALL of a user's unclaimed mentions into one outbox email, in one transaction: the mentions
 * are marked as belonging to that email at the same moment it is created, so each mention is in
 * exactly one email and two workers cannot both build one. The email itself is sent by the normal
 * outbox path.
 */
export const buildDigest = async (deps: Deps, userId: string): Promise<DigestResult> =>
  deps.db.transaction(async (tx): Promise<DigestResult> => {
    await lockUser(tx, userId);

    const [previous] = await tx
      .select({ at: max(emailDeliveries.createdAt) })
      .from(emailDeliveries)
      .where(and(eq(emailDeliveries.userId, userId), eq(emailDeliveries.kind, 'mention_digest')));
    if (
      previous?.at &&
      deps.now() - previous.at.getTime() < deps.config.timing.digestMinIntervalMs
    ) {
      return 'too_early';
    }

    const rows = await tx
      .select({
        commentId: commentMentions.commentId,
        body: comments.body,
        workspaceId: comments.workspaceId,
        cardId: cards.id,
        boardId: cards.boardId,
        cardTitle: cards.title,
        authorName: users.name,
        authorHandle: users.handle,
      })
      .from(commentMentions)
      .innerJoin(comments, eq(comments.id, commentMentions.commentId))
      .innerJoin(cards, and(eq(cards.id, comments.cardId), isNull(cards.deletedAt)))
      .innerJoin(users, eq(users.id, comments.authorId))
      .innerJoin(workspaceMembers, stillMember)
      .where(and(eq(commentMentions.userId, userId), isNull(commentMentions.deliveryId)))
      .orderBy(asc(commentMentions.createdAt), asc(commentMentions.commentId));
    const first = rows[0];
    if (!first) return 'nothing';

    const [recipient] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!recipient) return 'nothing';

    const [delivery] = await tx
      .insert(emailDeliveries)
      .values({
        kind: 'mention_digest',
        userId,
        toEmail: recipient.email,
        dedupeKey: `digest:${userId}:${first.commentId}`,
        payload: {
          mentions: rows.map((row) => ({
            workspaceId: row.workspaceId,
            cardTitle: row.cardTitle,
            authorName: row.authorName,
            authorHandle: row.authorHandle,
            excerpt: excerptOf(row.body),
            link: `${deps.config.appOrigin}/boards/${row.boardId}/cards/${row.cardId}`,
          })),
        },
      })
      .onConflictDoNothing()
      .returning({ id: emailDeliveries.id });
    if (!delivery) return 'nothing';

    await tx
      .update(commentMentions)
      .set({ deliveryId: delivery.id })
      .where(
        and(
          eq(commentMentions.userId, userId),
          isNull(commentMentions.deliveryId),
          inArray(
            commentMentions.commentId,
            rows.map((row) => row.commentId),
          ),
        ),
      );
    return 'created';
  });
