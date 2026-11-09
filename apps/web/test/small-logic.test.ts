import { describe, expect, it } from 'vitest';

import { checkFile } from '@/features/attachments/model/validate-file';
import { safeNext } from '@/features/auth/model/safe-next';
import { splitMentions } from '@/features/comments/model/mentions';

describe('safeNext (where to go after signing in)', () => {
  it.each([
    ['/boards/1', '/boards/1'],
    ['/search?q=a', '/search?q=a'],
    [undefined, '/'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['', '/'],
  ])('%j -> %j', (input, expected) => expect(safeNext(input)).toBe(expected));
  it('takes the first value if given several', () => expect(safeNext(['/a', '/b'])).toBe('/a'));
});

describe('checkFile (the browser-side look at an upload)', () => {
  const file = (over: Partial<{ name: string; size: number; type: string }> = {}) => ({
    name: 'a.png',
    size: 100,
    type: 'image/png',
    ...over,
  });
  it('accepts images and PDF up to exactly 10 MB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'])
      expect(checkFile(file({ type }))).toBeNull();
    expect(checkFile(file({ size: 10 * 1024 * 1024 }))).toBeNull();
  });
  it('refuses empty, oversize, other types and path-like names', () => {
    expect(checkFile(file({ size: 0 }))).toMatch(/empty/);
    expect(checkFile(file({ size: 10 * 1024 * 1024 + 1 }))).toMatch(/10 MB/);
    for (const type of ['image/svg+xml', 'text/html', 'application/x-msdownload', ''])
      expect(checkFile(file({ type }))).toMatch(/Only images/);
    expect(checkFile(file({ name: '../x.png' }))).toMatch(/slashes/);
  });
});

describe('splitMentions (highlighting @handles in a comment)', () => {
  const text = (parts: { text: string; mention: boolean }[]) =>
    parts.map((p) => (p.mention ? `[${p.text}]` : p.text)).join('');
  it('marks only handles that really mention someone', () => {
    expect(text(splitMentions('hi @bob and @ghost, write to bob@x.io', ['bob']))).toBe(
      'hi [@bob] and @ghost, write to bob@x.io',
    );
  });
  it('ignores trailing punctuation and letter case', () => {
    expect(text(splitMentions('thanks @Bob.', ['bob']))).toBe('thanks [@Bob].');
  });
  it('never turns text into markup: it only splits strings', () => {
    expect(
      splitMentions('<b>@bob</b>', ['bob'])
        .map((p) => p.text)
        .join(''),
    ).toBe('<b>@bob</b>');
  });
  it('handles empty input and no mentions', () => {
    expect(splitMentions('', ['bob'])).toEqual([]);
    expect(splitMentions('plain', [])).toEqual([{ text: 'plain', mention: false }]);
  });
});
