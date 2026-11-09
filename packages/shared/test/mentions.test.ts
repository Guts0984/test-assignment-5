import { describe, expect, it } from 'vitest';

import { extractMentions } from '../src';

describe('extractMentions', () => {
  it.each([
    ['hi @alice', ['alice']],
    ['hi @alice, and @bob!', ['alice', 'bob']],
    ['(@alice) said so', ['alice']],
    ['thanks @alice.', ['alice']],
    ['ping @alice-', ['alice']],
    ['@Alice and @ALICE again', ['alice']],
    ['line one\n@bob\nline three', ['bob']],
    ['@a.b_c-d works', ['a.b_c-d']],
  ])('finds the handles in %j', (body, expected) => {
    expect(extractMentions(body)).toEqual(expected);
  });

  it.each([
    ['', 'empty'],
    ['no mentions here', 'plain text'],
    ['write to alice@example.com', 'an email address'],
    ['user@alice.io', 'the host part of an email'],
    ['@al', 'a handle that is too short'],
    [`@${'a'.repeat(33)}`, 'a handle that is too long'],
    ['@@@', 'only at signs'],
    ['@алиса', 'non-latin text'],
    ['@ alice', 'a space after the at sign'],
    ['price is 5@10', 'a number'],
  ])('finds nobody in %j (%s)', (body) => {
    expect(extractMentions(body)).toEqual([]);
  });

  it('accepts a handle of exactly 32 characters', () => {
    const handle = `a${'x'.repeat(30)}b`;
    expect(extractMentions(`@${handle}`)).toEqual([handle]);
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    extractMentions(`@${'a'.repeat(200_000)}`);
    extractMentions('@'.repeat(200_000));
    extractMentions('a@'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
