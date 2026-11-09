'use client';

import {
  joinResultSchema,
  PRESENCE_HEARTBEAT_MS,
  serverEventSchemas,
  type BoardSnapshot,
  type PresenceUser,
  type ServerEventName,
  type ServerEventPayload,
} from '@kanban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';

import { applyEvent, boardKey, trackerFor } from '@/features/boards';
import { toast } from '@/shared/ui/toaster';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';
type Context = {
  status: ConnectionStatus;
  presence: PresenceUser[];
  setEditing: (cardId: string | null) => void;
};

const RealtimeContext = createContext<Context>({
  status: 'connecting',
  presence: [],
  setEditing: () => undefined,
});
export const useRealtime = (): Context => useContext(RealtimeContext);

/**
 * Keeps one board live. On every (re)connect it joins the board and replaces the cache with the
 * snapshot the server sends (so a client that was away is current again); after that, each event
 * patches just the card or position it is about. Events are validated with the shared schemas and
 * applied only if they are not older than what the cache shows.
 */
export const RealtimeProvider = ({
  boardId,
  children,
}: {
  boardId: string;
  children: ReactNode;
}) => {
  const client = useQueryClient();
  const router = useRouter();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io({ path: '/socket.io', transports: ['websocket'], withCredentials: true });
    socketRef.current = socket;
    const tracker = trackerFor(boardId);

    const join = async () => {
      try {
        const reply = joinResultSchema.parse(
          await socket.timeout(8_000).emitWithAck('board.join', { boardId }),
        );
        if (!reply.ok) {
          setStatus('offline');
          if (reply.error === 'not_found') router.replace('/');
          return;
        }
        tracker.reset(reply.lastEventId);
        client.setQueryData(boardKey(boardId), reply.snapshot);
        setPresence(reply.presence);
        setStatus('live');
      } catch {
        setStatus('offline');
      }
    };

    socket.on('connect', () => void join());
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('connect_error', () => setStatus('offline'));

    // The server's event names are validated by the shared schemas, not by socket.io's types.
    const listen = socket.on.bind(socket) as (
      event: string,
      listener: (raw: unknown) => void,
    ) => void;
    /** Validates a message with the shared schema before anything uses it. */
    const on = <K extends ServerEventName>(
      name: K,
      handler: (payload: ServerEventPayload<K>) => void,
    ) => {
      listen(name, (raw: unknown) => {
        const parsed = serverEventSchemas[name].safeParse(raw);
        if (parsed.success) handler(parsed.data as unknown as ServerEventPayload<K>);
      });
    };
    /** A board change patches the one card (or position) it is about, if it is not stale. */
    const patchBoard = <
      K extends
        'card.created' | 'card.updated' | 'card.moved' | 'card.deleted' | 'column.rebalanced',
    >(
      name: K,
      payload: ServerEventPayload<K>,
    ) =>
      client.setQueryData<BoardSnapshot>(boardKey(boardId), (current) =>
        current ? applyEvent(current, name, payload, tracker) : current,
      );

    on('card.created', (payload) => patchBoard('card.created', payload));
    on('card.updated', (payload) => patchBoard('card.updated', payload));
    on('card.moved', (payload) => patchBoard('card.moved', payload));
    on('card.deleted', (payload) => patchBoard('card.deleted', payload));
    on('column.rebalanced', (payload) => patchBoard('column.rebalanced', payload));
    on(
      'comment.created',
      (payload) =>
        void client.invalidateQueries({ queryKey: ['comments', payload.comment.cardId] }),
    );
    on(
      'attachment.ready',
      (payload) =>
        void client.invalidateQueries({ queryKey: ['attachments', payload.attachment.cardId] }),
    );
    on('presence.snapshot', (payload) => setPresence(payload.users));
    on('access.revoked', () => {
      toast('You no longer have access to this board.', 'error');
      router.replace('/');
    });

    // A silent client is dropped from the presence list after three missed beats.
    const heartbeat = setInterval(
      () => socket.connected && socket.emit('presence.heartbeat', { boardId }),
      PRESENCE_HEARTBEAT_MS,
    );

    return () => {
      clearInterval(heartbeat);
      socket.emit('board.leave', { boardId });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [boardId, client, router]);

  const value = useMemo<Context>(
    () => ({
      status,
      presence,
      setEditing: (cardId) => {
        if (socketRef.current?.connected)
          socketRef.current.emit('presence.editing', { boardId, cardId });
      },
    }),
    [status, presence, boardId],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
};
