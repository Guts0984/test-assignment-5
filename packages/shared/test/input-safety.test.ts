import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  createAttachmentBodySchema,
  createCardBodySchema,
  createCommentBodySchema,
  createInviteBodySchema,
  loginBodySchema,
  moveCardBodySchema,
  pageQuerySchema,
  registerBodySchema,
  searchQuerySchema,
  updateCardBodySchema,
} from '../src';

const id = '123e4567-e89b-12d3-a456-426614174000';
const NUL = '\u0000';

type Case = {
  name: string;
  schema: z.ZodType;
  valid: Record<string, unknown>;
  textFields: string[];
};

const cases: Case[] = [
  {
    name: 'register',
    schema: registerBodySchema,
    valid: { email: 'a@b.io', handle: 'alice', name: 'Alice', password: 'longenough1' },
    textFields: ['name', 'password'],
  },
  {
    name: 'login',
    schema: loginBodySchema,
    valid: { email: 'a@b.io', password: 'x' },
    textFields: ['password'],
  },
  {
    name: 'create card',
    schema: createCardBodySchema,
    valid: { columnId: id, title: 'Title', description: 'Text' },
    textFields: ['title', 'description'],
  },
  {
    name: 'update card',
    schema: updateCardBodySchema,
    valid: { version: 1, title: 'Title', description: 'Text' },
    textFields: ['title', 'description'],
  },
  {
    name: 'create comment',
    schema: createCommentBodySchema,
    valid: { body: 'hello @bob' },
    textFields: ['body'],
  },
  {
    name: 'create attachment',
    schema: createAttachmentBodySchema,
    valid: { fileName: 'photo.png', contentType: 'image/png', sizeBytes: 100 },
    textFields: ['fileName'],
  },
  {
    name: 'search',
    schema: searchQuerySchema,
    valid: { q: 'login', workspace: id },
    textFields: ['q'],
  },
  {
    name: 'page query (cursor)',
    schema: pageQuerySchema,
    valid: { cursor: 'abc' },
    textFields: ['cursor'],
  },
];

describe('NUL bytes (PostgreSQL would answer with a 500)', () => {
  for (const { name, schema, valid, textFields } of cases) {
    it(`${name}: the valid body parses`, () => {
      expect(schema.safeParse(valid).success).toBe(true);
    });

    for (const field of textFields) {
      it(`${name}: rejects a NUL byte in "${field}"`, () => {
        const bad = { ...valid, [field]: `before${NUL}after` };
        expect(schema.safeParse(bad).success).toBe(false);
      });
    }
  }
});

describe('ids', () => {
  const badIds = [
    'not-a-uuid',
    '',
    "' OR 1=1 --",
    `${id}${NUL}`,
    `${id}x`,
    '123',
    'ffffffff-ffff-ffff-ffff-fffffffffffg',
  ];

  it.each(badIds)('rejects %j wherever an id is expected', (bad) => {
    expect(moveCardBodySchema.safeParse({ columnId: bad }).success).toBe(false);
    expect(moveCardBodySchema.safeParse({ columnId: id, afterId: bad }).success).toBe(false);
    expect(moveCardBodySchema.safeParse({ columnId: id, beforeId: bad }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'x', workspace: bad }).success).toBe(false);
  });

  it('accepts any well-formed id, including ones that are not RFC-4122 versions', () => {
    // PostgreSQL's uuid type accepts these, and test data uses them.
    expect(
      moveCardBodySchema.safeParse({ columnId: '00000000-0000-0000-0000-000000000000' }).success,
    ).toBe(true);
  });
});

describe('limits are exact', () => {
  it('card title: 200 characters pass, 201 and blank fail', () => {
    const body = (title: string) => createCardBodySchema.safeParse({ columnId: id, title }).success;
    expect(body('x'.repeat(200))).toBe(true);
    expect(body('x'.repeat(201))).toBe(false);
    expect(body('   ')).toBe(false);
    expect(body('')).toBe(false);
  });

  it('card description: 20000 pass, 20001 fail, empty is allowed and is the default', () => {
    const body = (description: string) =>
      createCardBodySchema.safeParse({ columnId: id, title: 't', description });
    expect(body('x'.repeat(20_000)).success).toBe(true);
    expect(body('x'.repeat(20_001)).success).toBe(false);
    expect(createCardBodySchema.parse({ columnId: id, title: 't' }).description).toBe('');
  });

  it('comment: 5000 pass, 5001 fail, blank fails', () => {
    const body = (text: string) => createCommentBodySchema.safeParse({ body: text }).success;
    expect(body('x'.repeat(5_000))).toBe(true);
    expect(body('x'.repeat(5_001))).toBe(false);
    expect(body('   \n\t ')).toBe(false);
  });

  it('password: 8..128 characters, kept exactly as typed', () => {
    const parse = (password: string) =>
      registerBodySchema.safeParse({ email: 'a@b.io', handle: 'alice', name: 'A', password });
    expect(parse('1234567').success).toBe(false);
    expect(parse('12345678').success).toBe(true);
    expect(parse('x'.repeat(128)).success).toBe(true);
    expect(parse('x'.repeat(129)).success).toBe(false);
    expect(parse('  padded pass  ').data?.password).toBe('  padded pass  ');
  });

  it('search query: 200 pass, 201 and blank fail', () => {
    const q = (value: string) => searchQuerySchema.safeParse({ q: value, workspace: id }).success;
    expect(q('x'.repeat(200))).toBe(true);
    expect(q('x'.repeat(201))).toBe(false);
    expect(q('   ')).toBe(false);
  });
});

describe('identity fields are normalised', () => {
  it('lowercases and trims email and handle', () => {
    const parsed = registerBodySchema.parse({
      email: '  Alice@Example.COM ',
      handle: ' Alice ',
      name: ' Alice ',
      password: 'longenough1',
    });
    expect(parsed).toMatchObject({ email: 'alice@example.com', handle: 'alice', name: 'Alice' });
    expect(createInviteBodySchema.parse({ email: ' Bob@X.io ', role: 'editor' }).email).toBe(
      'bob@x.io',
    );
  });

  it.each([
    'ab',
    'a'.repeat(33),
    'alice.',
    '.alice',
    '-alice',
    'al ice',
    'ali/ce',
    'алиса',
    'ali\u0000ce',
  ])('rejects the handle %j', (handle) => {
    const body = { email: 'a@b.io', handle, name: 'A', password: 'longenough1' };
    expect(registerBodySchema.safeParse(body).success).toBe(false);
  });

  it.each(['abc', 'a.b', 'a-b-c', 'a_b', `a${'x'.repeat(30)}b`])(
    'accepts the handle %j',
    (handle) => {
      const body = { email: 'a@b.io', handle, name: 'A', password: 'longenough1' };
      expect(registerBodySchema.safeParse(body).success).toBe(true);
    },
  );

  it('an invite cannot make someone an owner', () => {
    expect(createInviteBodySchema.safeParse({ email: 'a@b.io', role: 'owner' }).success).toBe(
      false,
    );
  });
});

describe('card updates', () => {
  it('require the version the editor started from', () => {
    expect(updateCardBodySchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(updateCardBodySchema.safeParse({ version: 0, title: 'x' }).success).toBe(false);
    expect(updateCardBodySchema.safeParse({ version: 1.5, title: 'x' }).success).toBe(false);
    expect(updateCardBodySchema.safeParse({ version: '1', title: 'x' }).success).toBe(false);
  });

  it('require at least one field to change', () => {
    expect(updateCardBodySchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateCardBodySchema.safeParse({ version: 1, description: '' }).success).toBe(true);
  });
});

describe('moves', () => {
  it('accept absent, null or valid neighbours', () => {
    expect(moveCardBodySchema.safeParse({ columnId: id }).success).toBe(true);
    expect(
      moveCardBodySchema.safeParse({ columnId: id, afterId: null, beforeId: null }).success,
    ).toBe(true);
    expect(moveCardBodySchema.safeParse({ columnId: id, afterId: id, beforeId: id }).success).toBe(
      true,
    );
  });

  it('refuse a client mutation id that could be abused', () => {
    for (const clientMutationId of ['', 'a b', 'x'.repeat(65), '<script>', `ok${NUL}`]) {
      expect(moveCardBodySchema.safeParse({ columnId: id, clientMutationId }).success).toBe(false);
    }
    expect(moveCardBodySchema.safeParse({ columnId: id, clientMutationId: 'm-1_a' }).success).toBe(
      true,
    );
  });
});

describe('attachments', () => {
  const body = (overrides: Record<string, unknown>) =>
    createAttachmentBodySchema.safeParse({
      fileName: 'a.png',
      contentType: 'image/png',
      sizeBytes: 1,
      ...overrides,
    });

  it('enforce the 10 MB limit to the byte', () => {
    expect(body({ sizeBytes: 10 * 1024 * 1024 }).success).toBe(true);
    expect(body({ sizeBytes: 10 * 1024 * 1024 + 1 }).success).toBe(false);
    for (const sizeBytes of [0, -1, 1.5, '100', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(body({ sizeBytes }).success).toBe(false);
    }
  });

  it('only allow images and PDF, never active content', () => {
    for (const ok of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']) {
      expect(body({ contentType: ok }).success).toBe(true);
    }
    for (const bad of [
      'image/svg+xml', // can carry scripts
      'text/html',
      'application/x-msdownload',
      'application/octet-stream',
      'image/png; charset=x',
      'IMAGE/PNG',
      '',
    ]) {
      expect(body({ contentType: bad }).success).toBe(false);
    }
  });

  it('refuse file names that look like paths', () => {
    for (const fileName of ['../etc/passwd', 'a/b.png', 'a\\b.png', '/abs.png', '']) {
      expect(body({ fileName }).success).toBe(false);
    }
    expect(body({ fileName: 'my photo (1).png' }).success).toBe(true);
  });
});

describe('pagination', () => {
  it('coerces query strings and applies the default', () => {
    expect(pageQuerySchema.parse({}).limit).toBe(50);
    expect(pageQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it.each(['0', '-1', '101', '1.5', 'abc', '', 'NaN'])('rejects the limit %j', (limit) => {
    expect(pageQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects a cursor that is empty or huge', () => {
    expect(pageQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
  });
});
