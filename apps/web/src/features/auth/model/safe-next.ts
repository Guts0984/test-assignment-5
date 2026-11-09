/** Where to go after signing in: only paths inside this site, never another address. */
export const safeNext = (value: string | string[] | undefined): string => {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    !candidate ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\')
  )
    return '/';
  return candidate;
};
