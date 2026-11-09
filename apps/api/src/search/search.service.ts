import type { DatabaseHandle } from '@kanban/db';
import {
  LIMITS,
  type HighlightedText,
  type SearchPage,
  type SearchQuery,
  type SearchResult,
} from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../common/app-error';
import { DATABASE } from '../infra/tokens';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

const SCALE = 1_000_000;
/** Control characters mark the matches; they are stripped from the text first so they cannot be forged. */
const START = '\u0001';
const STOP = '\u0002';

const cursorSchema = z.tuple([z.number().int(), z.union([z.literal(0), z.literal(1)]), z.guid()]);

const encodeCursor = (rank: number, order: 0 | 1, id: string): string =>
  Buffer.from(JSON.stringify([rank, order, id])).toString('base64url');

const decodeCursor = (cursor: string) => {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
  } catch {
    throw new AppError('validation_failed', 'Invalid cursor');
  }
};

/** "a <mark>b</mark> c" as segments, so the client never has to trust or parse HTML. */
const toSegments = (marked: string | null): HighlightedText => {
  if (!marked) return [];
  const segments: HighlightedText = [];
  for (const [index, part] of marked.split(START).entries()) {
    if (index === 0) {
      if (part) segments.push({ text: part, match: false });
      continue;
    }
    const [hit = '', rest = ''] = part.split(STOP);
    if (hit) segments.push({ text: hit, match: true });
    if (rest) segments.push({ text: rest, match: false });
  }
  return segments;
};

type Row = {
  ord: number;
  id: string;
  card_id: string;
  board_id: string;
  comment_id: string | null;
  rank: string;
  title_hl: string | null;
  snippet_hl: string | null;
};

@Injectable()
export class SearchService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
  ) {}

  /**
   * Full-text search over cards and comments of ONE workspace the caller belongs to. The workspace
   * filter is part of every query branch, so results can never include anything from elsewhere.
   * Results are ranked (title matches outrank description and comment matches), highlighted, and
   * paged with a keyset cursor that stays stable while new content is added.
   */
  async search(userId: string, query: SearchQuery): Promise<SearchPage> {
    await this.access.require(userId, query.workspace, 'viewer');
    const limit = Math.min(query.limit, LIMITS.pageSize.max);
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;

    const cursorFilter = after
      ? sql`where rank < ${after[0]} or (rank = ${after[0]} and (ord > ${after[1]} or (ord = ${after[1]} and id > ${after[2]}::uuid)))`
      : sql``;
    const options = sql`'StartSel=' || chr(1) || ', StopSel=' || chr(2)`;
    const strip = (column: ReturnType<typeof sql.raw>) =>
      sql`translate(${column}, chr(1) || chr(2), '')`;

    const result = await this.database.db.execute<Row>(sql`
      with q as (select websearch_to_tsquery('english', ${query.q}) as tsq),
      matches as (
        select 0 as ord, c.id as id, c.id as card_id, c.board_id as board_id, null::uuid as comment_id,
               (ts_rank_cd(c.search_vector, q.tsq) * ${SCALE})::bigint as rank,
               c.title as title, c.description as body
        from cards c, q
        where c.workspace_id = ${query.workspace}::uuid and c.deleted_at is null and c.search_vector @@ q.tsq
        union all
        select 1, m.id, c.id, c.board_id, m.id,
               (ts_rank_cd(m.search_vector, q.tsq) * ${SCALE})::bigint,
               c.title, m.body
        from comments m join cards c on c.id = m.card_id, q
        where m.workspace_id = ${query.workspace}::uuid and c.deleted_at is null and m.search_vector @@ q.tsq
      ),
      page as (
        select * from matches
        ${cursorFilter}
        order by rank desc, ord asc, id asc
        limit ${limit + 1}
      )
      select page.ord, page.id, page.card_id, page.board_id, page.comment_id, page.rank,
             ts_headline('english', ${strip(sql.raw('page.title'))}, q.tsq, ${options} || ', HighlightAll=true') as title_hl,
             ts_headline('english', ${strip(sql.raw('page.body'))}, q.tsq,
                         ${options} || ', MaxFragments=1, MaxWords=30, MinWords=12, ShortWord=2') as snippet_hl
      from page, q
      order by page.rank desc, page.ord asc, page.id asc
    `);

    const rows = result.rows;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row): SearchResult => ({
      kind: row.ord === 0 ? 'card' : 'comment',
      boardId: row.board_id,
      cardId: row.card_id,
      commentId: row.comment_id,
      cardTitle: toSegments(row.title_hl),
      snippet: toSegments(row.snippet_hl),
      rank: Number(row.rank) / SCALE,
    }));
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(Number(last.rank), last.ord === 0 ? 0 : 1, last.id)
          : null,
    };
  }
}
