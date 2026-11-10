import type { Server as HttpServer } from 'node:http';

import { activityLog, cards, type DatabaseHandle } from '@kanban/db';
import { clientEventSchemas, type JoinResult } from '@kanban/shared';
import { createAdapter } from '@socket.io/redis-adapter';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { and, eq, isNull, max } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';

import { readCookie } from '../auth/auth.guard';
import { type AuthUser, SESSION_COOKIE } from '../auth/auth-user';
import { SessionService } from '../auth/session.service';
import { BoardsService } from '../boards/boards.service';
import { AppError } from '../common/app-error';
import type { AppConfig } from '../config';
import { APP_CONFIG, DATABASE, REDIS } from '../infra/tokens';
import { clientIpOf } from '../rate-limit/client-ip';
import { RateLimiter } from '../rate-limit/rate-limiter';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { MEMBERSHIP_CHANNEL, membershipEventSchema } from '../workspaces/membership-events';
import { BoardEvents, boardRoom } from './board-events';
import { PresenceService } from './presence.service';

type SocketData = {
  user: AuthUser;
  /** The visitor's address, as the HTTP limiter sees it. */
  ip: string;
  /** Boards this connection is subscribed to, with the workspace each belongs to. */
  boards: Map<string, string>;
  /** Flood protection (token bucket) and the number of messages dropped so far. */
  tokens: number;
  refilledAt: number;
  dropped: number;
  /** Separate, much smaller budget for board.join: it is the one expensive message. */
  joinTokens: number;
  joinRefilledAt: number;
  /** Joins being served right now, so a repeated join of the same board shares the work. */
  joining: Map<string, Promise<JoinResult>>;
};

const BUCKET_CAPACITY = 30;
const REFILL_PER_SECOND = 15;
/** After this many dropped messages the connection is closed. */
/** One socket may join this many boards in a burst, then one more every JOIN_REFILL_SECONDS. */
const JOIN_BURST = 5;
const JOIN_REFILL_SECONDS = 2;
const MAX_DROPPED = 100;
const MAX_BOARDS_PER_SOCKET = 20;
const SWEEP_INTERVAL_MS = 1_000;

const dataOf = (socket: Socket): SocketData => socket.data as SocketData;

/**
 * Real-time updates over Socket.IO, attached to the API's HTTP server.
 *
 *  - Authentication: the same session cookie as HTTP (and the page's Origin, because browsers do
 *    not apply the same-origin policy to WebSockets).
 *  - Authorisation: a connection can only join boards of workspaces its user belongs to. Membership
 *    is re-checked on every heartbeat and presence message, and removed members are thrown out
 *    immediately through a Redis notification that every instance handles for its own sockets.
 *  - Both instances share rooms through the Redis adapter, so a change made through one instance
 *    reaches viewers connected to the other.
 *  - Every connection is rate limited and its payloads are validated with the shared schemas.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private io?: Server;
  private readonly redisClients: Redis[] = [];
  private sweeper?: NodeJS.Timeout;
  private closing = false;
  /** Open connections per address on this instance. */
  private readonly connectionsByIp = new Map<string, number>();
  private readonly lastPresence = new Map<string, string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(BoardsService) private readonly boards: BoardsService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(BoardEvents) private readonly events: BoardEvents,
  ) {}

  attach(httpServer: HttpServer): void {
    const io = new Server(httpServer, {
      // WebSocket only: no long-polling fallback means no sticky sessions are needed behind nginx.
      transports: ['websocket'],
      serveClient: false,
      maxHttpBufferSize: 64 * 1024,
      pingInterval: 5_000,
      pingTimeout: 5_000,
      allowRequest: (request, callback) => {
        this.admit(request.headers, request.socket.remoteAddress).then(
          (verdict) => callback(verdict, verdict === null),
          () => callback('unavailable', false),
        );
      },
    });
    this.io = io;

    const duplicate = (): Redis => {
      const client = this.redis.duplicate({ enableOfflineQueue: true, commandTimeout: undefined });
      client.on('error', (error) => this.logger.warn(`redis (realtime) error: ${error.message}`));
      this.redisClients.push(client);
      return client;
    };
    io.adapter(createAdapter(duplicate(), duplicate()));

    io.use((socket, next) => this.guard(this.authenticate(socket, next)));
    io.on('connection', (socket) => this.onConnection(socket));

    this.events.setSink((room, name, payload) => {
      io.to(room).emit(name, payload);
    });

    const membership = duplicate();
    void membership
      .subscribe(MEMBERSHIP_CHANNEL)
      .catch((error: Error) => this.logger.warn(`cannot subscribe: ${error.message}`));
    membership.on('message', (_channel, message) => this.guard(this.onMembershipChange(message)));

    this.sweeper = setInterval(() => this.guard(this.sweepPresence()), SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closing) return; // already shut down (or shutting down)
    this.closing = true; // from here on nothing is broadcast: the connections it would use are closing
    clearInterval(this.sweeper);
    this.events.setSink(undefined);
    const io = this.io;
    if (io) {
      const leaving = [...io.of('/').sockets.values()];
      await Promise.allSettled(
        leaving.flatMap((socket) =>
          [...dataOf(socket).boards.keys()].map((boardId) =>
            this.presence.remove(boardId, socket.id),
          ),
        ),
      );
      for (const socket of leaving) dataOf(socket).boards.clear(); // their presence is already gone
      // Only THIS instance's connections: with the Redis adapter, a plain disconnectSockets()
      // would disconnect clients that are connected to the other instances as well.
      io.local.disconnectSockets(true);
      io.engine.close();
      await Promise.resolve(io.of('/').adapter.close()).catch(() => undefined);
    }
    for (const client of this.redisClients) client.disconnect();
  }

  /** Handlers run without anyone awaiting them: a failure is logged, never left unhandled. */
  private guard(work: Promise<void>): void {
    work.catch((error: unknown) =>
      this.logger.warn(
        `realtime handler failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  // ---- connection setup ---------------------------------------------------------------------

  private async authenticate(socket: Socket, next: (error?: Error) => void): Promise<void> {
    const origin = socket.handshake.headers.origin;
    if (origin !== undefined && origin !== this.config.appOrigin)
      return next(new Error('forbidden'));
    try {
      const sessionId = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      const user = sessionId ? await this.sessions.resolve(sessionId) : null;
      if (!user) return next(new Error('unauthorized'));
      const ip = await clientIpOf(
        socket.handshake.headers,
        socket.request.socket.remoteAddress,
        this.config.clientIpSecret,
      );
      socket.data = {
        user,
        ip,
        boards: new Map(),
        tokens: BUCKET_CAPACITY,
        refilledAt: Date.now(),
        dropped: 0,
        joinTokens: JOIN_BURST,
        joinRefilledAt: Date.now(),
        joining: new Map(),
      } satisfies SocketData;
      next();
    } catch {
      next(new Error('unavailable'));
    }
  }

  /**
   * Runs for every WebSocket upgrade BEFORE the connection exists. WebSocket traffic never passes
   * through the HTTP rate limiter (Express does not see it), so it needs limits of its own, keyed
   * by the same visitor address: connections per minute (counted across all API instances) and
   * simultaneous connections. Returns null to admit, or an error code to refuse.
   */
  private async admit(
    headers: Record<string, string | string[] | undefined>,
    peerAddress: string | undefined,
  ): Promise<string | null> {
    const ip = await clientIpOf(headers, peerAddress, this.config.clientIpSecret);
    const { wsConnectsPerMinute, wsMaxConnectionsPerIp } = this.config.rateLimit;
    if ((this.connectionsByIp.get(ip) ?? 0) >= wsMaxConnectionsPerIp) return 'too_many_connections';
    const attempt = await this.limiter.hit(`rl:ws-connect:${ip}`, wsConnectsPerMinute, 60_000);
    return attempt.allowed ? null : 'rate_limited';
  }

  private onConnection(socket: Socket): void {
    const { ip } = dataOf(socket);
    this.connectionsByIp.set(ip, (this.connectionsByIp.get(ip) ?? 0) + 1);
    socket.on('disconnect', () => {
      const left = (this.connectionsByIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.connectionsByIp.delete(ip);
      else this.connectionsByIp.set(ip, left);
    });

    // Two layers: this connection's own bucket, then the visitor's total over ALL its connections
    // (opening many sockets must not multiply the allowance).
    socket.use((_packet, next) => {
      if (!this.allow(socket)) return next(new Error('rate_limited'));
      this.limiter
        .hit(`rl:ws-msg:${ip}`, this.config.rateLimit.wsMessagesPer10s, 10_000)
        .then((result) => {
          if (result.allowed) return next();
          this.noteDrop(socket);
          next(new Error('rate_limited'));
        })
        .catch(() => next());
    });

    socket.on('board.join', (payload: unknown, ack: unknown) =>
      this.guard(this.onJoin(socket, payload, ack)),
    );
    socket.on('board.leave', (payload: unknown) => this.guard(this.onLeave(socket, payload)));
    socket.on('presence.editing', (payload: unknown) =>
      this.guard(this.onEditing(socket, payload)),
    );
    socket.on('presence.heartbeat', (payload: unknown) =>
      this.guard(this.onHeartbeat(socket, payload)),
    );
    socket.on('disconnect', () => this.guard(this.onDisconnect(socket)));
    socket.on('error', () => undefined); // errors raised by the rate limiter must not become unhandled
  }

  /** Token bucket: short bursts are fine, a sustained flood is dropped and finally disconnected. */
  private allow(socket: Socket): boolean {
    const data = dataOf(socket);
    const now = Date.now();
    data.tokens = Math.min(
      BUCKET_CAPACITY,
      data.tokens + ((now - data.refilledAt) / 1000) * REFILL_PER_SECOND,
    );
    data.refilledAt = now;
    if (data.tokens >= 1) {
      data.tokens -= 1;
      return true;
    }
    this.noteDrop(socket);
    return false;
  }

  private noteDrop(socket: Socket): void {
    const data = dataOf(socket);
    data.dropped += 1;
    if (data.dropped >= MAX_DROPPED) socket.disconnect(true);
  }

  // ---- messages from clients ----------------------------------------------------------------

  private async onJoin(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
    const reply =
      typeof ack === 'function' ? (ack as (result: JoinResult) => void) : () => undefined;
    const parsed = clientEventSchemas['board.join'].safeParse(payload);
    if (!parsed.success) return reply({ ok: false, error: 'not_found' });
    const { boardId } = parsed.data;
    const data = dataOf(socket);

    // Every message pays this socket's own allowance, even one that only shares an answer being
    // built: sending a 450 KB snapshot over and over is expensive too.
    if (!this.takeJoinToken(socket)) return reply({ ok: false, error: 'rate_limited' });

    // The same board asked for again while the first answer is still being built: share it.
    const running = data.joining.get(boardId);
    if (running) return reply(await running);

    // Registered before anything is awaited, so the next identical join finds it.
    const work = this.admitAndJoin(socket, boardId);
    data.joining.set(boardId, work);
    try {
      reply(await work);
    } finally {
      data.joining.delete(boardId);
    }
  }

  private async admitAndJoin(socket: Socket, boardId: string): Promise<JoinResult> {
    const data = dataOf(socket);
    // Cheap refusals first, before any database work: the snapshot is by far the most expensive
    // thing a client can ask for.
    if (!data.boards.has(boardId) && data.boards.size >= MAX_BOARDS_PER_SOCKET)
      return { ok: false, error: 'rate_limited' };
    // Then the visitor's and the user's shared allowances (counted across all instances).
    const limit = this.config.rateLimit.wsJoinsPer10s;
    for (const key of [`rl:ws-join:ip:${data.ip}`, `rl:ws-join:user:${data.user.id}`]) {
      if (!(await this.limiter.hit(key, limit, 10_000)).allowed) {
        this.noteDrop(socket);
        return { ok: false, error: 'rate_limited' };
      }
    }
    return this.join(socket, boardId);
  }

  /** Token bucket just for joins: a small burst, then one every JOIN_REFILL_SECONDS. */
  private takeJoinToken(socket: Socket): boolean {
    const data = dataOf(socket);
    const now = Date.now();
    data.joinTokens = Math.min(
      JOIN_BURST,
      data.joinTokens + (now - data.joinRefilledAt) / 1000 / JOIN_REFILL_SECONDS,
    );
    data.joinRefilledAt = now;
    if (data.joinTokens < 1) {
      this.noteDrop(socket);
      return false;
    }
    data.joinTokens -= 1;
    return true;
  }

  private async join(socket: Socket, boardId: string): Promise<JoinResult> {
    const data = dataOf(socket);
    const wasJoined = data.boards.has(boardId);
    try {
      const { workspaceId } = await this.access
        .requireForBoard(data.user.id, boardId, 'viewer')
        .catch((error: unknown) => {
          // Only a real "no such board / not your workspace" answer means not found; anything
          // else (the database is down, a timeout) is a fault and must not look like one.
          if (
            error instanceof AppError &&
            (error.code === 'not_found' || error.code === 'forbidden')
          )
            throw new NotAllowed();
          throw error;
        });
      // Subscribe first, then read: nothing that happens in between can be missed.
      await socket.join(boardRoom(boardId));
      data.boards.set(boardId, workspaceId);
      const [{ last }] = (await this.database.db
        .select({ last: max(activityLog.id) })
        .from(activityLog)
        .where(eq(activityLog.boardId, boardId))) as [{ last: number | null }];
      const snapshot = await this.boards.get(data.user.id, boardId);
      await this.touchPresence(socket, boardId, {
        user: this.ref(data.user),
        editingCardId: null,
      });
      const users = await this.presence.snapshot(boardId);
      this.broadcastPresence(boardId, users);
      return { ok: true, snapshot, presence: users, lastEventId: last ?? 0 };
    } catch (error) {
      if (!(error instanceof NotAllowed))
        this.logger.warn(
          `board.join failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      // A join that failed half way must leave nothing behind (room, board record, presence entry).
      // But a failed RE-join of a board the socket was already watching must not throw away a
      // working subscription, unless the reason is that access is gone.
      if (error instanceof NotAllowed || !wasJoined)
        await this.leaveBoard(socket, boardId).catch(() => undefined);
      return { ok: false, error: error instanceof NotAllowed ? 'not_found' : 'unavailable' };
    }
  }

  private async onLeave(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventSchemas['board.leave'].safeParse(payload);
    if (!parsed.success) return;
    await this.leaveBoard(socket, parsed.data.boardId);
  }

  /** Only editors and owners announce what they edit; for anyone else the message does nothing. */
  private async onEditing(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventSchemas['presence.editing'].safeParse(payload);
    if (!parsed.success) return;
    const { boardId, cardId } = parsed.data;
    const data = dataOf(socket);
    if (!data.boards.has(boardId)) return;
    try {
      if (!(await this.stillAllowed(socket, boardId, 'editor'))) return;
      if (cardId) {
        const [card] = await this.database.db
          .select({ id: cards.id })
          .from(cards)
          .where(and(eq(cards.id, cardId), eq(cards.boardId, boardId), isNull(cards.deletedAt)))
          .limit(1);
        if (!card) return;
      }
      await this.touchPresence(socket, boardId, {
        user: this.ref(data.user),
        editingCardId: cardId,
      });
      this.broadcastPresence(boardId, await this.presence.snapshot(boardId));
    } catch (error) {
      this.logger.warn(
        `presence.editing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async onHeartbeat(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventSchemas['presence.heartbeat'].safeParse(payload);
    if (!parsed.success) return;
    const { boardId } = parsed.data;
    const data = dataOf(socket);
    if (!data.boards.has(boardId)) return;
    try {
      // The safety net behind the revocation broadcast: a lost notification is noticed here.
      if (!(await this.stillAllowed(socket, boardId, 'viewer'))) return;
      const editing =
        (await this.presence.snapshot(boardId)).find((entry) => entry.user.id === data.user.id)
          ?.editingCardId ?? null;
      await this.touchPresence(socket, boardId, {
        user: this.ref(data.user),
        editingCardId: editing,
      });
    } catch (error) {
      this.logger.warn(
        `presence.heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async onDisconnect(socket: Socket): Promise<void> {
    const data = dataOf(socket);
    if (!data?.boards) return;
    for (const boardId of [...data.boards.keys()])
      await this.leaveBoard(socket, boardId).catch(() => undefined);
  }

  // ---- access ------------------------------------------------------------------------------

  /** True if the user may still use this board; otherwise the connection is thrown out of it. */
  private async stillAllowed(
    socket: Socket,
    boardId: string,
    minimum: 'viewer' | 'editor',
  ): Promise<boolean> {
    try {
      await this.access.requireForBoard(dataOf(socket).user.id, boardId, minimum);
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'not_found') await this.revoke(socket, boardId);
      return false; // 'forbidden' (too low a role) just means "not allowed to do this"
    }
  }

  private async revoke(socket: Socket, boardId: string): Promise<void> {
    socket.emit('access.revoked', { boardId });
    await this.leaveBoard(socket, boardId);
  }

  private async leaveBoard(socket: Socket, boardId: string): Promise<void> {
    const data = dataOf(socket);
    if (!data.boards.delete(boardId)) return;
    await socket.leave(boardRoom(boardId));
    await this.presence.remove(boardId, socket.id);
    this.broadcastPresence(boardId, await this.presence.snapshot(boardId));
  }

  /** Runs on every instance for its own connections when someone is removed from a workspace. */
  private async onMembershipChange(message: string): Promise<void> {
    try {
      const event = membershipEventSchema.parse(JSON.parse(message));
      if (event.type !== 'removed' || !this.io) return;
      for (const socket of this.io.of('/').sockets.values()) {
        const data = dataOf(socket);
        if (data?.user.id !== event.userId) continue;
        for (const [boardId, workspaceId] of [...data.boards.entries()]) {
          if (workspaceId === event.workspaceId) await this.revoke(socket, boardId);
        }
      }
    } catch (error) {
      this.logger.warn(
        `bad membership notification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Records presence, then makes sure the connection is still on the board. A message that was
   * already being processed when the client left, was thrown out or was disconnected would
   * otherwise finish AFTER the cleanup and bring the user back as a ghost. Whatever the order of
   * the two, the entry ends up removed: either the cleanup removed it after this write, or the
   * check below does.
   */
  private async touchPresence(
    socket: Socket,
    boardId: string,
    entry: Parameters<PresenceService['touch']>[2],
  ): Promise<void> {
    await this.presence.touch(boardId, socket.id, entry);
    if (!dataOf(socket).boards.has(boardId) || !socket.connected) {
      await this.presence.remove(boardId, socket.id);
    }
  }

  // ---- presence -----------------------------------------------------------------------------

  private ref(user: AuthUser) {
    return { id: user.id, handle: user.handle, name: user.name };
  }

  private broadcastPresence(
    boardId: string,
    users: Awaited<ReturnType<PresenceService['snapshot']>>,
  ): void {
    if (this.closing) return;
    this.lastPresence.set(boardId, JSON.stringify(users));
    this.io?.to(boardRoom(boardId)).emit('presence.snapshot', { boardId, users });
  }

  /**
   * Entries of vanished clients expire in Redis by themselves; this notices and tells the room.
   * It covers the cases a clean disconnect never reports (a crashed instance, a lost network).
   */
  private async sweepPresence(): Promise<void> {
    if (!this.io) return;
    const boardIds = new Set<string>();
    for (const socket of this.io.of('/').sockets.values())
      for (const id of dataOf(socket)?.boards.keys() ?? []) boardIds.add(id);
    for (const boardId of boardIds) {
      try {
        const users = await this.presence.snapshot(boardId);
        if (JSON.stringify(users) !== this.lastPresence.get(boardId))
          this.broadcastPresence(boardId, users);
      } catch {
        // Redis is down: nothing to do, the next sweep tries again.
      }
    }
  }
}

class NotAllowed extends Error {}
