import { HANDLE_PATTERN } from './common';

/**
 * `@handle` that is not part of a longer word or an email address (`a@b.com` mentions nobody).
 * Trailing "." and "-" are punctuation, not part of the handle ("thanks @alice."). Candidates
 * that are not a valid handle (too short, too long) mention nobody.
 */
const MENTION = /(?<![\w.@-])@([a-z0-9][a-z0-9_.-]*)/gi;

/** Distinct, lowercase handles mentioned in `body`, in order of first appearance. */
export const extractMentions = (body: string): string[] => {
  const handles = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    const candidate = (match[1] ?? '').toLowerCase().replace(/[.-]+$/, '');
    if (HANDLE_PATTERN.test(candidate)) handles.add(candidate);
  }
  return [...handles];
};
