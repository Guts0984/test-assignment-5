import { describe, expect, it } from 'vitest';

import {
  clientEventSchemas,
  ERROR_CODES,
  ERROR_STATUS,
  errorBodySchema,
  joinResultSchema,
  serverEventSchemas,
} from '../src';

const id = '123e4567-e89b-12d3-a456-426614174000';

describe('error codes', () => {
  it('map to a valid status, and only server faults are 5xx', () => {
    for (const code of ERROR_CODES) {
      const status = ERROR_STATUS[code];
      expect(Number.isInteger(status) && status >= 400 && status < 600).toBe(true);
      if (code !== 'internal_error' && code !== 'service_unavailable')
        expect(status).toBeLessThan(500);
    }
  });

  it('keep bad input a 4xx and a version conflict a 409', () => {
    expect(ERROR_STATUS.validation_failed).toBe(400);
    expect(ERROR_STATUS.version_conflict).toBe(409);
    expect(ERROR_STATUS.not_found).toBe(404);
    expect(ERROR_STATUS.rate_limited).toBe(429);
  });

  it('describe the one error body shape', () => {
    const body = { error: { code: 'validation_failed', message: 'bad', details: { issues: [] } } };
    expect(errorBodySchema.safeParse(body).success).toBe(true);
    expect(errorBodySchema.safeParse({ error: { code: 'made_up', message: 'x' } }).success).toBe(
      false,
    );
  });
});

describe('socket messages from clients', () => {
  it('are validated before use: junk and malformed payloads fail without throwing', () => {
    const junk = [
      undefined,
      null,
      0,
      'text',
      [],
      {},
      { boardId: 'nope' },
      { boardId: id, extra: 1, cardId: 5 },
    ];
    for (const schema of Object.values(clientEventSchemas)) {
      for (const payload of junk) {
        expect(() => schema.safeParse(payload)).not.toThrow();
      }
    }
    expect(clientEventSchemas['board.join'].safeParse({ boardId: 'nope' }).success).toBe(false);
    expect(
      clientEventSchemas['presence.editing'].safeParse({ boardId: id, cardId: 5 }).success,
    ).toBe(false);
  });

  it('allow clearing the edited card with null, but not omitting it', () => {
    expect(
      clientEventSchemas['presence.editing'].safeParse({ boardId: id, cardId: null }).success,
    ).toBe(true);
    expect(clientEventSchemas['presence.editing'].safeParse({ boardId: id }).success).toBe(false);
  });
});

describe('socket messages from the server', () => {
  it('always carry the ordering envelope', () => {
    const withoutEventId = {
      boardId: id,
      actorId: null,
      clientMutationId: null,
      cardId: id,
      columnId: id,
    };
    expect(serverEventSchemas['card.deleted'].safeParse(withoutEventId).success).toBe(false);
    expect(
      serverEventSchemas['card.deleted'].safeParse({ ...withoutEventId, eventId: 7 }).success,
    ).toBe(true);
  });

  it('give a failed join an error code and a successful one a snapshot', () => {
    expect(joinResultSchema.safeParse({ ok: false, error: 'not_found' }).success).toBe(true);
    expect(joinResultSchema.safeParse({ ok: true }).success).toBe(false);
    expect(joinResultSchema.safeParse({ ok: false, error: 'boom' }).success).toBe(false);
  });
});
