import type { ServerEventName, ServerEventPayload } from '@kanban/shared';
import { Injectable } from '@nestjs/common';

type Sink = (room: string, event: string, payload: unknown) => void;

export const boardRoom = (boardId: string): string => `board:${boardId}`;

/**
 * Where services announce what happened on a board. The Socket.IO gateway plugs itself in as the
 * sink; until it does (and in tests that run without it) announcements go nowhere, so services
 * never depend on the transport.
 */
@Injectable()
export class BoardEvents {
  private sink?: Sink;

  setSink(sink: Sink | undefined): void {
    this.sink = sink;
  }

  emit<K extends ServerEventName>(name: K, payload: ServerEventPayload<K>): void {
    this.sink?.(boardRoom(payload.boardId), name, payload);
  }
}
