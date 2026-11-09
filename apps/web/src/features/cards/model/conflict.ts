import { versionConflictDetailsSchema, type Card } from '@kanban/shared';

import { isApiError } from '@/shared/lib/client-api';

/** The card that won, if the failure is a version conflict from the API; otherwise null. */
export const conflictingCard = (error: unknown): Card | null => {
  if (!isApiError(error) || error.status !== 409 || error.code !== 'version_conflict') return null;
  const parsed = versionConflictDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data.current : null;
};
