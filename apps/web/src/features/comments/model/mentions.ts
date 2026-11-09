export type BodyPart = { text: string; mention: boolean };

/** Splits a comment into plain text and the @handles that really mention someone. */
export const splitMentions = (body: string, handles: string[]): BodyPart[] => {
  const known = new Set(handles.map((handle) => handle.toLowerCase()));
  const parts: BodyPart[] = [];
  let last = 0;
  for (const match of body.matchAll(/(?<![\w.@-])@([a-z0-9][a-z0-9_.-]*)/gi)) {
    const handle = (match[1] ?? '').toLowerCase().replace(/[.-]+$/, '');
    if (!known.has(handle)) continue;
    const start = match.index ?? 0;
    const end = start + 1 + handle.length;
    if (start > last) parts.push({ text: body.slice(last, start), mention: false });
    parts.push({ text: body.slice(start, end), mention: true });
    last = end;
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false });
  return parts;
};
