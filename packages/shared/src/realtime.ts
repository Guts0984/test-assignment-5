import { z } from 'zod';

import { attachmentSchema } from './attachments';
import { boardSchema, cardSchema, clientMutationIdSchema } from './boards';
import { commentSchema } from './comments';
import { idSchema, userRefSchema } from './common';

/**
 * Socket.IO contracts. Every board change is sent with an envelope:
 *  - `eventId` is the activity-log id of the change: strictly increasing per database, so a
 *    client applies an event only if it is newer than what it already knows about that entity
 *    and ignores late or duplicated deliveries;
 *  - `clientMutationId` is echoed back so the sender can recognise its own change.
 */
const envelope = z.object({
  eventId: z.number().int(),
  boardId: idSchema,
  actorId: idSchema.nullable(),
  clientMutationId: clientMutationIdSchema.nullable(),
});

/** Clients send `presence.heartbeat` this often; the server forgets a silent client after 3 missed beats. */
export const PRESENCE_HEARTBEAT_MS = 2_000;

export const presenceUserSchema = z.object({
  user: userRefSchema,
  /** The card this user is editing right now, if any. */
  editingCardId: idSchema.nullable(),
});
export type PresenceUser = z.infer<typeof presenceUserSchema>;

export const serverEventSchemas = {
  'card.created': envelope.extend({ card: cardSchema }),
  'card.updated': envelope.extend({ card: cardSchema }),
  'card.moved': envelope.extend({ card: cardSchema, fromColumnId: idSchema }),
  'card.deleted': envelope.extend({ cardId: idSchema, columnId: idSchema }),
  /** Every key of a column was rewritten; apply all positions at once. */
  'column.rebalanced': envelope.extend({
    columnId: idSchema,
    positions: z.array(z.object({ id: idSchema, position: z.string() })),
  }),
  'comment.created': envelope.extend({ comment: commentSchema }),
  'attachment.ready': envelope.extend({ attachment: attachmentSchema }),
  /** The board was renamed. */
  'board.renamed': z.object({ boardId: idSchema, name: z.string() }),
  /** The board was deleted; viewers must leave it. */
  'board.deleted': z.object({ boardId: idSchema }),
  /** Complete current list, sent on every change of who is on the board. */
  'presence.snapshot': z.object({ boardId: idSchema, users: z.array(presenceUserSchema) }),
  /** Sent right before the server drops the subscription because membership was removed. */
  'access.revoked': z.object({ boardId: idSchema }),
} as const;

export const clientEventSchemas = {
  'board.join': z.object({ boardId: idSchema }),
  'board.leave': z.object({ boardId: idSchema }),
  'presence.editing': z.object({ boardId: idSchema, cardId: idSchema.nullable() }),
  'presence.heartbeat': z.object({ boardId: idSchema }),
} as const;

/** Acknowledgement of `board.join`; also what a client receives again after reconnecting. */
export const joinResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    snapshot: boardSchema,
    presence: z.array(presenceUserSchema),
    /** Events with a larger `eventId` happened after `snapshot` and must be applied on top. */
    lastEventId: z.number().int(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(['not_found', 'rate_limited', 'unauthorized', 'unavailable']),
  }),
]);
export type JoinResult = z.infer<typeof joinResultSchema>;

export type ServerEventName = keyof typeof serverEventSchemas;
export type ServerEventPayload<K extends ServerEventName> = z.infer<(typeof serverEventSchemas)[K]>;
export type ClientEventName = keyof typeof clientEventSchemas;
export type ClientEventPayload<K extends ClientEventName> = z.infer<(typeof clientEventSchemas)[K]>;

/** Generic arguments for Socket.IO's typed `Server` / `Socket`. */
export type ServerToClientEvents = {
  [K in ServerEventName]: (payload: ServerEventPayload<K>) => void;
};
export type ClientToServerEvents = {
  'board.join': (
    payload: ClientEventPayload<'board.join'>,
    ack: (result: JoinResult) => void,
  ) => void;
  'board.leave': (payload: ClientEventPayload<'board.leave'>) => void;
  'presence.editing': (payload: ClientEventPayload<'presence.editing'>) => void;
  'presence.heartbeat': (payload: ClientEventPayload<'presence.heartbeat'>) => void;
};
