import { describe, expect, it } from 'vitest';

import { escapeHtml, excerptOf, renderDigest, renderInvite } from '../src/mail/render';

const invite = {
  workspaceName: 'Acme',
  role: 'editor',
  invitedBy: 'Alice',
  link: 'http://localhost:8080/invite/abc',
};
const mentionOf = (overrides: Record<string, unknown> = {}) => ({
  cardTitle: 'Fix login',
  authorName: 'Bob',
  authorHandle: 'bob',
  excerpt: 'look at this',
  link: 'http://localhost:8080/boards/b/cards/c',
  ...overrides,
});

describe('invitation email', () => {
  it('names the workspace and inviter, and carries the accept link in both versions', () => {
    const mail = renderInvite(invite)!;
    expect(mail.subject).toBe('Alice invited you to Acme');
    expect(mail.text).toContain('http://localhost:8080/invite/abc');
    expect(mail.html).toContain('href="http://localhost:8080/invite/abc"');
  });

  it('shows user-written names as text, never as markup', () => {
    const mail = renderInvite({
      ...invite,
      workspaceName: '<script>alert(1)</script>',
      invitedBy: '"><img src=x onerror=alert(1)>',
    })!;
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('keeps the subject on one line even if a name contains line breaks (header injection)', () => {
    const mail = renderInvite({ ...invite, invitedBy: 'Eve\r\nBcc: victim@example.com' })!;
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('refuses a payload it cannot render instead of sending something broken', () => {
    expect(renderInvite({})).toBeNull();
    expect(renderInvite({ ...invite, link: 'not a url' })).toBeNull();
    expect(renderInvite(null)).toBeNull();
  });
});

describe('mention digest email', () => {
  it('lists every mention, with the card, the author, an excerpt and a link', () => {
    const mail = renderDigest({
      mentions: [
        mentionOf(),
        mentionOf({ cardTitle: 'Other', authorName: 'Carol', authorHandle: 'carol' }),
      ],
    })!;
    expect(mail.subject).toBe('You were mentioned in 2 comments');
    expect(mail.text).toContain('Fix login');
    expect(mail.text).toContain('Carol (@carol) on "Other"');
    expect(mail.html.match(/<li>/g)).toHaveLength(2);
  });

  it('uses the singular for one mention, and escapes everything user-written', () => {
    const mail = renderDigest({
      mentions: [mentionOf({ cardTitle: '<b>bold</b>', excerpt: '"quoted" & <i>x</i>' })],
    })!;
    expect(mail.subject).toBe('You were mentioned in 1 comment');
    expect(mail.html).not.toContain('<b>bold</b>');
    expect(mail.html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(mail.html).toContain('&quot;quoted&quot; &amp; &lt;i&gt;x&lt;/i&gt;');
  });

  it('refuses an empty or malformed digest', () => {
    expect(renderDigest({ mentions: [] })).toBeNull();
    expect(renderDigest({})).toBeNull();
    expect(renderDigest({ mentions: [{ cardTitle: 'x' }] })).toBeNull();
  });
});

describe('helpers', () => {
  it('escapes the five characters that matter in HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('shortens long comments to a one-line excerpt', () => {
    expect(excerptOf('short')).toBe('short');
    expect(excerptOf('line one\n\n   line   two')).toBe('line one line two');
    const long = excerptOf('word '.repeat(100));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
  });
});
