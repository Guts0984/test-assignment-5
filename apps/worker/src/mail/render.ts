import { z } from 'zod';

export type RenderedMail = { subject: string; text: string; html: string };

const inviteSchema = z.object({
  workspaceName: z.string(),
  role: z.string(),
  invitedBy: z.string(),
  link: z.url(),
});

const digestSchema = z.object({
  mentions: z
    .array(
      z.object({
        cardTitle: z.string(),
        authorName: z.string(),
        authorHandle: z.string(),
        excerpt: z.string(),
        link: z.url(),
      }),
    )
    .min(1),
});

/** User-written text goes into HTML, so it is escaped: a card titled `<script>` stays text. */
export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** A header value must be one line. */
const oneLine = (value: string): string =>
  value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);

export const excerptOf = (body: string, max = 160): string => {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** `null` means the stored payload is not something we can send (the row is marked failed). */
export const renderInvite = (payload: unknown): RenderedMail | null => {
  const parsed = inviteSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { workspaceName, role, invitedBy, link } = parsed.data;
  return {
    subject: oneLine(`${invitedBy} invited you to ${workspaceName}`),
    text: `${invitedBy} invited you to join "${workspaceName}" as ${role}.\n\nAccept the invitation: ${link}\n\nIf you did not expect this, you can ignore this email.`,
    html:
      `<p>${escapeHtml(invitedBy)} invited you to join <strong>${escapeHtml(workspaceName)}</strong> as ${escapeHtml(role)}.</p>` +
      `<p><a href="${escapeHtml(link)}">Accept the invitation</a></p>` +
      `<p>If you did not expect this, you can ignore this email.</p>`,
  };
};

export const renderDigest = (payload: unknown): RenderedMail | null => {
  const parsed = digestSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { mentions } = parsed.data;
  const subject =
    mentions.length === 1
      ? 'You were mentioned in 1 comment'
      : `You were mentioned in ${mentions.length} comments`;
  return {
    subject,
    text: mentions
      .map(
        (m) =>
          `${m.authorName} (@${m.authorHandle}) on "${m.cardTitle}":\n  ${m.excerpt}\n  ${m.link}`,
      )
      .join('\n\n'),
    html:
      `<p>${escapeHtml(subject)}:</p><ul>` +
      mentions
        .map(
          (m) =>
            `<li><strong>${escapeHtml(m.authorName)}</strong> (@${escapeHtml(m.authorHandle)}) on ` +
            `<a href="${escapeHtml(m.link)}">${escapeHtml(m.cardTitle)}</a>:<br>${escapeHtml(m.excerpt)}</li>`,
        )
        .join('') +
      `</ul>`,
  };
};
