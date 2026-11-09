import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Fractional-index key. `COLLATE "C"` forces byte-wise comparison, so ordering is identical
 * in every environment (the default collation is locale-dependent and would reorder keys).
 */
export const positionKey = customType<{ data: string }>({
  dataType: () => 'text COLLATE "C"',
});

export const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

export const primaryId = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
