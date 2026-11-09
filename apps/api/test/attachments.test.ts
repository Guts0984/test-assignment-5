import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { activityLog, attachments } from '@kanban/db';
import {
  attachmentSchema,
  cardSchema,
  createAttachmentResponseSchema,
  downloadLinkSchema,
  LIMITS,
} from '@kanban/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';
import {
  as,
  asJson,
  makeBoard,
  makeWorkspace,
  registerUser,
  testDb,
  type TestUser,
} from './support/world';

let api: RunningApp;
let alice: TestUser; // owner
let bob: TestUser; // editor
let carol: TestUser; // viewer
let dave: TestUser; // other workspace
let eve: TestUser; // nowhere
let board: { id: string; columnIds: string[] };
let storage: S3Client;

const url = (path: string) => `${api.url}${path}`;

// Real file contents. What counts is the bytes, never the name.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const EXE = Buffer.concat([
  Buffer.from('MZ'),
  Buffer.alloc(600, 0x90),
  Buffer.from('This program cannot be run in DOS mode.'),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>',
);
const HTML = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');

const newCard = async () =>
  cardSchema.parse(
    (
      await call(
        url(`/boards/${board.id}/cards`),
        asJson(alice, 'POST', { columnId: board.columnIds[0], title: 'with files' }),
      )
    ).body,
  ).id;

const register = (
  user: TestUser,
  cardId: string,
  file: { fileName: string; contentType: string; sizeBytes: number },
) => call(url(`/cards/${cardId}/attachments`), asJson(user, 'POST', file));

/** What the browser does with the signed form: fields first, then the file, straight to storage. */
const upload = async (
  form: { url: string; fields: Record<string, string> },
  bytes: Buffer,
  overrides: Record<string, string> = {},
) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...form.fields, ...overrides }))
    data.append(key, value);
  data.append('file', new Blob([new Uint8Array(bytes)]), 'upload');
  return fetch(form.url, { method: 'POST', body: data });
};

/** Register + upload + complete in one go. */
const attach = async (
  cardId: string,
  bytes: Buffer,
  declared: string,
  fileName = 'file.bin',
  user = bob,
) => {
  const created = await register(user, cardId, {
    fileName,
    contentType: declared,
    sizeBytes: bytes.length,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { attachment, upload: form } = createAttachmentResponseSchema.parse(created.body);
  const stored = await upload(form, bytes);
  expect(stored.status, await stored.clone().text()).toBeLessThan(300);
  return {
    id: attachment.id,
    complete: (as_ = user) =>
      call(url(`/attachments/${attachment.id}/complete`), asJson(as_, 'POST', {})),
  };
};

const keyOf = async (attachmentId: string): Promise<string> => {
  const [row] = await testDb()
    .db.select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId));
  if (!row) throw new Error('attachment row not found');
  return row.objectKey;
};

const objectExists = (key: string): Promise<boolean> =>
  storage.send(new HeadObjectCommand({ Bucket: inject('infra').s3.bucket, Key: key })).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  api = await startApp(testConfig());
  const users = await Promise.all(
    ['alice', 'bob', 'carol', 'dave', 'eve'].map((n) => registerUser(api.url, n)),
  );
  [alice, bob, carol, dave, eve] = users as [TestUser, TestUser, TestUser, TestUser, TestUser];
  const workspace = await makeWorkspace([
    { user: alice, role: 'owner' },
    { user: bob, role: 'editor' },
    { user: carol, role: 'viewer' },
  ]);
  await makeWorkspace([{ user: dave, role: 'owner' }]);
  board = await makeBoard(workspace.id);
  const s3 = inject('infra').s3;
  storage = new S3Client({
    region: 'us-east-1',
    endpoint: s3.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
  });
});

afterAll(async () => {
  await api.close();
});

describe('the happy path', () => {
  it('registers, uploads straight to storage, completes, lists and downloads the same bytes', async () => {
    const cardId = await newCard();
    const created = await register(bob, cardId, {
      fileName: 'photo.png',
      contentType: 'image/png',
      sizeBytes: PNG.length,
    });
    expect(created.status).toBe(201);
    const { attachment, upload: form } = createAttachmentResponseSchema.parse(created.body);
    expect(attachment).toMatchObject({ status: 'pending', fileName: 'photo.png' });
    expect((await call(url(`/cards/${cardId}/attachments`), as(bob))).body).toEqual([]); // not visible until completed

    expect((await upload(form, PNG)).status).toBe(204);
    const done = await call(url(`/attachments/${attachment.id}/complete`), asJson(bob, 'POST', {}));
    expect(attachmentSchema.parse(done.body)).toMatchObject({
      status: 'ready',
      contentType: 'image/png',
      sizeBytes: PNG.length,
    });

    const listed = (await call(url(`/cards/${cardId}/attachments`), as(carol))).body as unknown[]; // viewers may see
    expect(listed.map((a) => attachmentSchema.parse(a).id)).toEqual([attachment.id]);

    const link = downloadLinkSchema.parse(
      (await call(url(`/attachments/${attachment.id}/download`), as(carol))).body,
    );
    const file = await fetch(link.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('accepts GIF and PDF too, and records the detected type', async () => {
    const cardId = await newCard();
    expect((await (await attach(cardId, GIF, 'image/gif', 'a.gif')).complete()).body).toMatchObject(
      { contentType: 'image/gif' },
    );
    expect(
      (await (await attach(cardId, PDF, 'application/pdf', 'a.pdf')).complete()).body,
    ).toMatchObject({ contentType: 'application/pdf' });
  });

  it('records completion in the activity log', async () => {
    const cardId = await newCard();
    const file = await attach(cardId, PNG, 'image/png', 'log.png');
    await file.complete();
    const rows = await testDb()
      .db.select()
      .from(activityLog)
      .where(eq(activityLog.entityId, file.id));
    expect(rows.map((r) => r.type)).toEqual(['attachment.added']);
  });
});

describe('the type comes from the content, not from the name', () => {
  it.each([
    ['an .exe renamed to .png', EXE, 'image/png', 'holiday.png'],
    ['an .exe declared as a PDF', EXE, 'application/pdf', 'invoice.pdf'],
    ['an SVG with a script, declared as PNG', SVG, 'image/png', 'logo.png'],
    ['an HTML page declared as PNG', HTML, 'image/png', 'page.png'],
    [
      'an empty-looking text file declared as PNG',
      Buffer.from('hello world, not an image'),
      'image/png',
      'note.png',
    ],
  ])('refuses %s, deletes the object and the row', async (_label, bytes, declared, fileName) => {
    const cardId = await newCard();
    const file = await attach(cardId, bytes, declared, fileName);
    const key = await keyOf(file.id);
    expect(await objectExists(key)).toBe(true); // storage accepted it; only the content check can stop it
    expectError(await file.complete(), 415, 'unsupported_media_type');

    expect(await objectExists(key)).toBe(false); // the object is deleted...
    const rows = await testDb().db.select().from(attachments).where(eq(attachments.id, file.id));
    expect(rows).toEqual([]); // ...and so is the row
    expect((await call(url(`/cards/${cardId}/attachments`), as(bob))).body).toEqual([]);
    expectError(await call(url(`/attachments/${file.id}/download`), as(bob)), 404, 'not_found');
  });

  it('trusts the bytes over the declaration when both are allowed types', async () => {
    const cardId = await newCard();
    const file = await attach(cardId, PDF, 'image/png', 'actually.png');
    expect((await file.complete()).body).toMatchObject({ contentType: 'application/pdf' });
    const link = downloadLinkSchema.parse(
      (await call(url(`/attachments/${file.id}/download`), as(bob))).body,
    );
    expect((await fetch(link.url)).headers.get('content-type')).toBe('application/pdf'); // served as what it really is
  });
});

describe('size limits', () => {
  it('refuse to even register a file above 10 MB, or an empty one', async () => {
    const cardId = await newCard();
    const attempt = (sizeBytes: number) =>
      register(bob, cardId, { fileName: 'big.png', contentType: 'image/png', sizeBytes });
    expectError(await attempt(LIMITS.attachmentBytes + 1), 400, 'validation_failed');
    expectError(await attempt(11 * 1024 * 1024), 400, 'validation_failed');
    expectError(await attempt(0), 400, 'validation_failed');
    expect((await attempt(LIMITS.attachmentBytes)).status).toBe(201);
  });

  it('are enforced by storage itself: sending more than was declared is rejected', async () => {
    const cardId = await newCard();
    const created = await register(bob, cardId, {
      fileName: 'liar.png',
      contentType: 'image/png',
      sizeBytes: 100,
    });
    const { attachment, upload: form } = createAttachmentResponseSchema.parse(created.body);
    const refused = await upload(form, Buffer.concat([PNG, Buffer.alloc(5_000, 1)]));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expectError(
      await call(url(`/attachments/${attachment.id}/complete`), asJson(bob, 'POST', {})),
      409,
      'conflict',
    );
  });

  it('are enforced by storage at the real 10 MB boundary', async () => {
    const cardId = await newCard();
    const created = await register(bob, cardId, {
      fileName: 'huge.png',
      contentType: 'image/png',
      sizeBytes: LIMITS.attachmentBytes,
    });
    const { upload: form } = createAttachmentResponseSchema.parse(created.body);
    const tooBig = Buffer.concat([PNG, Buffer.alloc(LIMITS.attachmentBytes, 1)]); // 10 MB + a PNG header
    expect((await upload(form, tooBig)).status).toBeGreaterThanOrEqual(400);
  });

  it('refuse an upload whose content type differs from the one that was signed', async () => {
    const cardId = await newCard();
    const created = await register(bob, cardId, {
      fileName: 'a.png',
      contentType: 'image/png',
      sizeBytes: PNG.length,
    });
    const { upload: form } = createAttachmentResponseSchema.parse(created.body);
    expect(
      (await upload(form, PNG, { 'Content-Type': 'text/html' })).status,
    ).toBeGreaterThanOrEqual(400);
  });
});

describe('completing', () => {
  it('is refused before anything was uploaded', async () => {
    const created = await register(bob, await newCard(), {
      fileName: 'a.png',
      contentType: 'image/png',
      sizeBytes: 10,
    });
    const id = createAttachmentResponseSchema.parse(created.body).attachment.id;
    expectError(
      await call(url(`/attachments/${id}/complete`), asJson(bob, 'POST', {})),
      409,
      'conflict',
    );
  });

  it('can be repeated or raced without harm: one result, one journal entry', async () => {
    const file = await attach(await newCard(), PNG, 'image/png', 'once.png');
    const results = await Promise.all(Array.from({ length: 6 }, () => file.complete()));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => (r.body as { id: string }).id)).size).toBe(1);
    expect((await file.complete()).status).toBe(200);
    const rows = await testDb()
      .db.select()
      .from(activityLog)
      .where(eq(activityLog.entityId, file.id));
    expect(rows).toHaveLength(1);
  });
});

describe('who may do what', () => {
  it('only editors and owners can register or complete uploads', async () => {
    const cardId = await newCard();
    const body = { fileName: 'a.png', contentType: 'image/png', sizeBytes: PNG.length };
    expectError(await register(carol, cardId, body), 403, 'forbidden');
    for (const outsider of [eve, dave])
      expectError(await register(outsider, cardId, body), 404, 'not_found');

    const file = await attach(cardId, PNG, 'image/png', 'a.png');
    expectError(await file.complete(carol), 403, 'forbidden');
    expectError(await file.complete(eve), 404, 'not_found');
    expectError(await file.complete(dave), 404, 'not_found');
    expect((await file.complete()).status).toBe(200);
  });

  it('outsiders cannot list or download, and other people’s ids look like nothing exists', async () => {
    const cardId = await newCard();
    const file = await attach(cardId, PNG, 'image/png', 'private.png');
    await file.complete();
    for (const outsider of [eve, dave]) {
      expectError(await call(url(`/cards/${cardId}/attachments`), as(outsider)), 404, 'not_found');
      expectError(
        await call(url(`/attachments/${file.id}/download`), as(outsider)),
        404,
        'not_found',
      );
    }
    expectError(
      await call(url('/attachments/123e4567-e89b-42d3-a456-426614174999/download'), as(eve)),
      404,
      'not_found',
    );
    expectError(await call(url(`/attachments/${file.id}/download`)), 401, 'unauthorized');
    expectError(await call(url('/attachments/nope/download'), as(alice)), 400, 'validation_failed');
  });

  it('files that are not completed, or whose card was deleted, cannot be downloaded', async () => {
    const cardId = await newCard();
    const pending = createAttachmentResponseSchema.parse(
      (await register(bob, cardId, { fileName: 'p.png', contentType: 'image/png', sizeBytes: 10 }))
        .body,
    );
    expectError(
      await call(url(`/attachments/${pending.attachment.id}/download`), as(bob)),
      404,
      'not_found',
    );

    const done = await attach(cardId, PNG, 'image/png', 'd.png');
    await done.complete();
    expect((await call(url(`/attachments/${done.id}/download`), as(bob))).status).toBe(200);
    await call(url(`/cards/${cardId}`), { method: 'DELETE', ...as(alice) });
    expectError(await call(url(`/attachments/${done.id}/download`), as(bob)), 404, 'not_found');
  });
});

describe('download links', () => {
  it('last five minutes by default', async () => {
    const file = await attach(await newCard(), PNG, 'image/png', 'ttl.png');
    await file.complete();
    const link = downloadLinkSchema.parse(
      (await call(url(`/attachments/${file.id}/download`), as(bob))).body,
    );
    expect(new URL(link.url).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(290_000);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
  });

  it('really stop working once expired, and cannot be altered', async () => {
    const short = await startApp(testConfig({ downloadLinkTtlSeconds: 2 }));
    try {
      const file = await attach(
        await (async () => {
          const id = cardSchema.parse(
            (
              await call(
                `${short.url}/boards/${board.id}/cards`,
                asJson(alice, 'POST', { columnId: board.columnIds[0], title: 'short' }),
              )
            ).body,
          ).id;
          return id;
        })(),
        PNG,
        'image/png',
        'short.png',
      );
      await call(`${short.url}/attachments/${file.id}/complete`, asJson(bob, 'POST', {}));
      const link = downloadLinkSchema.parse(
        (await call(`${short.url}/attachments/${file.id}/download`, as(bob))).body,
      );

      expect((await fetch(link.url)).status).toBe(200);
      const tampered = new URL(link.url);
      tampered.searchParams.set('X-Amz-Signature', 'a'.repeat(64));
      expect((await fetch(tampered)).status).toBeGreaterThanOrEqual(400);
      const longer = new URL(link.url);
      longer.searchParams.set('X-Amz-Expires', '3600');
      expect((await fetch(longer)).status).toBeGreaterThanOrEqual(400);

      await new Promise((resolve) => setTimeout(resolve, 3_500));
      expect((await fetch(link.url)).status).toBeGreaterThanOrEqual(400); // expired
    } finally {
      await short.close();
    }
  }, 30_000);

  it('present the file under a safe, correctly encoded name', async () => {
    const file = await attach(
      await newCard(),
      PDF,
      'application/pdf',
      'отчёт "Q4"\r\nX-Evil: 1.pdf',
    );
    await file.complete();
    const link = downloadLinkSchema.parse(
      (await call(url(`/attachments/${file.id}/download`), as(bob))).body,
    );
    const disposition = (await fetch(link.url)).headers.get('content-disposition') ?? '';
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? '')).toBe(
      'отчёт "Q4"\r\nX-Evil: 1.pdf',
    );
  });

  it('encodes every character the filename* syntax does not allow, such as quotes, brackets and stars', async () => {
    const name = "it's (the) *final* report!.pdf";
    const file = await attach(await newCard(), PDF, 'application/pdf', name);
    await file.complete();
    const link = downloadLinkSchema.parse(
      (await call(url(`/attachments/${file.id}/download`), as(bob))).body,
    );
    const disposition = (await fetch(link.url)).headers.get('content-disposition') ?? '';
    const encoded = disposition.split("filename*=UTF-8''")[1] ?? '';
    expect(encoded).toMatch(/^[A-Za-z0-9!#$&+.^_`|~%-]+$/); // RFC 8187 attr-char only
    expect(decodeURIComponent(encoded)).toBe(name);
  });
});
