import { cardSchema, searchPageSchema, type SearchPage } from '@kanban/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';
import { as, asJson, makeBoard, makeWorkspace, registerUser, type TestUser } from './support/world';

let api: RunningApp;
let alice: TestUser; // owner of A
let carol: TestUser; // viewer of A
let dave: TestUser; // owner of B
let eve: TestUser; // nowhere
let A: { id: string };
let B: { id: string };
let boardA: { id: string; columnIds: string[] };
let boardB: { id: string; columnIds: string[] };

const url = (path: string) => `${api.url}${path}`;
const unique = () => `zz${Math.random().toString(36).slice(2, 9)}`;

const card = async (
  user: TestUser,
  board: { id: string; columnIds: string[] },
  title: string,
  description = '',
) =>
  cardSchema.parse(
    (
      await call(
        url(`/boards/${board.id}/cards`),
        asJson(user, 'POST', { columnId: board.columnIds[0], title, description }),
      )
    ).body,
  );
const comment = (user: TestUser, cardId: string, body: string) =>
  call(url(`/cards/${cardId}/comments`), asJson(user, 'POST', { body }));

const search = async (user: TestUser, q: string, workspace = A.id, extra = '') =>
  call(url(`/search?q=${encodeURIComponent(q)}&workspace=${workspace}${extra}`), as(user));
const hits = async (user: TestUser, q: string, workspace = A.id, extra = '') => {
  const response = await search(user, q, workspace, extra);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return searchPageSchema.parse(response.body);
};
const plain = (segments: { text: string }[]) => segments.map((s) => s.text).join('');
const marked = (segments: { text: string; match: boolean }[]) =>
  segments.filter((s) => s.match).map((s) => s.text.toLowerCase());

beforeAll(async () => {
  api = await startApp(testConfig());
  const users = await Promise.all(
    ['alice', 'carol', 'dave', 'eve'].map((n) => registerUser(api.url, n)),
  );
  [alice, carol, dave, eve] = users as [TestUser, TestUser, TestUser, TestUser];
  A = await makeWorkspace([
    { user: alice, role: 'owner' },
    { user: carol, role: 'viewer' },
  ]);
  B = await makeWorkspace([{ user: dave, role: 'owner' }]);
  boardA = await makeBoard(A.id);
  boardB = await makeBoard(B.id);
});

afterAll(async () => {
  await api.close();
});

describe('finding things', () => {
  it('matches title, description and comments, case-insensitively and by word form', async () => {
    const word = unique();
    const inTitle = await card(alice, boardA, `Deploying ${word} service`);
    const inBody = await card(
      alice,
      boardA,
      'Plain title',
      `We were running the ${word} migration yesterday`,
    );
    const inComment = await card(alice, boardA, 'Another plain title');
    await comment(alice, inComment.id, `remember the ${word.toUpperCase()}`);

    const found = await hits(carol, word); // viewers can search
    const ids = found.items.map((r) => r.cardId);
    expect(ids).toEqual(expect.arrayContaining([inTitle.id, inBody.id, inComment.id]));
    expect(found.items.find((r) => r.cardId === inComment.id)?.kind).toBe('comment');
    expect(found.items.find((r) => r.cardId === inComment.id)?.commentId).not.toBeNull();
    expect(found.items.find((r) => r.cardId === inTitle.id)?.kind).toBe('card');

    expect((await hits(alice, `deploy ${word}`)).items.map((r) => r.cardId)).toContain(inTitle.id); // "Deploying" ~ "deploy"
    expect((await hits(alice, `run ${word}`)).items.map((r) => r.cardId)).toContain(inBody.id); // "running" ~ "run"
  });

  it('ranks title matches above description and comment matches', async () => {
    const word = unique();
    const onlyBody = await card(alice, boardA, 'Unrelated', `${word} ${word}`);
    const inTitle = await card(alice, boardA, `${word} headline`);
    const found = await hits(alice, word);
    expect(found.items[0]?.cardId).toBe(inTitle.id);
    expect(found.items.map((r) => r.cardId)).toContain(onlyBody.id);
    const ranks = found.items.map((r) => r.rank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it('highlights the matching words as data, never as markup', async () => {
    const word = unique();
    const found = (await hits(alice, word, A.id)).items;
    expect(found).toEqual([]);

    await card(
      alice,
      boardA,
      `Report on ${word}`,
      `Long text before. The ${word} appeared here. Long text after.`,
    );
    const [item] = (await hits(alice, word)).items;
    expect(marked(item!.cardTitle)).toEqual([word]);
    expect(plain(item!.cardTitle)).toBe(`Report on ${word}`);
    expect(marked(item!.snippet)).toEqual([word]);
    expect(plain(item!.snippet)).toContain(`The ${word} appeared`);
  });

  it('returns hostile content as inert text, and cannot be confused by the highlight markers', async () => {
    const word = unique();
    await card(alice, boardA, `<script>alert(1)</script> ${word} \u0001forged\u0002 & <b>bold</b>`);
    const [item] = (await hits(alice, word)).items;
    const everything = plain(item!.cardTitle);
    expect(everything).toContain('<script>alert(1)</script>');
    expect(everything.includes('\u0001') || everything.includes('\u0002')).toBe(false); // markers in user text were removed
    expect(marked(item!.cardTitle)).toEqual([word]); // so "forged" is not highlighted
  });

  it('ignores deleted cards and comments on deleted cards', async () => {
    const word = unique();
    const gone = await card(alice, boardA, `${word} to delete`);
    const withComment = await card(alice, boardA, 'host');
    await comment(alice, withComment.id, `${word} in comment`);
    expect((await hits(alice, word)).items).toHaveLength(2);
    await call(url(`/cards/${gone.id}`), { method: 'DELETE', ...as(alice) });
    await call(url(`/cards/${withComment.id}`), { method: 'DELETE', ...as(alice) });
    expect((await hits(alice, word)).items).toEqual([]);
  });
});

describe('never reveals anything from another workspace', () => {
  it('finds nothing in workspace A for words that only exist in workspace B (and vice versa)', async () => {
    const secretB = unique();
    const secretA = unique();
    const cardB = await card(dave, boardB, `${secretB} merger plans`, `${secretB} confidential`);
    await comment(dave, cardB.id, `${secretB} comment`);
    await card(alice, boardA, `${secretA} roadmap`);

    expect((await hits(alice, secretB)).items).toEqual([]); // alice searching her own workspace for B's word
    expect((await hits(dave, secretA, B.id)).items).toEqual([]);
    expect((await hits(dave, secretB, B.id)).items.length).toBeGreaterThan(0); // control: B can find its own
  });

  it('a workspace you are not in is a 404, identical to one that does not exist', async () => {
    const word = unique();
    await card(dave, boardB, `${word} private`);
    const real = await search(alice, word, B.id);
    const fake = await search(alice, word, '123e4567-e89b-42d3-a456-426614174999');
    expect({ ...expectError(real, 404, 'not_found'), requestId: undefined }).toEqual({
      ...expectError(fake, 404, 'not_found'),
      requestId: undefined,
    });
    expectError(await search(eve, word, A.id), 404, 'not_found');
    expectError(await search(eve, word, B.id), 404, 'not_found');
    expectError(await call(url(`/search?q=${word}&workspace=${A.id}`)), 401, 'unauthorized');
  });

  it('cannot be tricked into the other workspace through the cursor', async () => {
    const word = unique();
    for (let i = 0; i < 4; i += 1) await card(dave, boardB, `${word} b${i}`);
    for (let i = 0; i < 4; i += 1) await card(alice, boardA, `${word} a${i}`);
    const first = await hits(alice, word, A.id, '&limit=2');
    expect(first.nextCursor).not.toBeNull();
    const forged = await hits(dave, word, B.id, `&limit=50&cursor=${first.nextCursor}`);
    expect(forged.items.every((r) => r.boardId === boardB.id)).toBe(true);
  });
});

describe('pagination', () => {
  it('walks every match exactly once, in rank order, however small the pages are', async () => {
    const word = unique();
    const created: string[] = [];
    for (let i = 0; i < 23; i += 1) {
      // varied ranks: more repetitions in the title rank higher
      created.push(
        (
          await card(
            alice,
            boardA,
            `${Array(1 + (i % 4))
              .fill(word)
              .join(' ')} item ${i}`,
          )
        ).id,
      );
    }
    const seen: string[] = [];
    const ranks: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: SearchPage = await hits(
        alice,
        word,
        A.id,
        `&limit=5${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(page.items.length).toBeLessThanOrEqual(5);
      seen.push(...page.items.map((r) => r.cardId));
      ranks.push(...page.items.map((r) => r.rank));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);

    expect(pages).toBe(5);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23); // no duplicates
    expect([...seen].sort()).toEqual([...created].sort()); // no omissions
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks); // one global ranking across pages
  });

  it('is not disturbed by matches that appear while paging', async () => {
    const word = unique();
    for (let i = 0; i < 6; i += 1) await card(alice, boardA, `${word} early ${i}`);
    const first = await hits(alice, word, A.id, '&limit=3');
    for (let i = 0; i < 3; i += 1) await card(alice, boardA, `${word} late ${i} ${word} ${word}`); // would outrank everything
    const second = await hits(alice, word, A.id, `&limit=3&cursor=${first.nextCursor}`);
    const firstIds = new Set(first.items.map((r) => r.cardId));
    expect(second.items.some((r) => firstIds.has(r.cardId))).toBe(false); // nothing repeated
  });
});

describe('any text can be searched for', () => {
  it.each([
    ['quotes', `"unbalanced quote`],
    ['sql injection', `'; drop table cards; --`],
    ['operators', `a & b | !c <-> (d) :* e`],
    ['only stop words', 'the and of'],
    ['punctuation only', '?!...'],
    ['emoji', '🙂🙂🙂'],
    ['very long', 'word '.repeat(40).trim()],
    ['backslashes', '\\\\ \\x00 \\u0000'],
    ['non-latin', 'пример поиска'],
  ])('%s: answered with a normal, possibly empty, result', async (_label, q) => {
    const response = await search(alice, q);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    searchPageSchema.parse(response.body);
  });

  it('rejects what is not a valid query with a 4xx', async () => {
    for (const q of ['', '   ', 'x'.repeat(201), 'a\u0000b']) {
      expectError(await search(alice, q), 400, 'validation_failed');
    }
    expectError(await call(url(`/search?workspace=${A.id}`), as(alice)), 400, 'validation_failed');
    expectError(await call(url('/search?q=x'), as(alice)), 400, 'validation_failed');
    expectError(await call(url('/search?q=x&workspace=nope'), as(alice)), 400, 'validation_failed');
    for (const bad of ['limit=0', 'limit=101', 'cursor=garbage', 'cursor=%00']) {
      expectError(await search(alice, 'x', A.id, `&${bad}`), 400, 'validation_failed');
    }
  });
});
