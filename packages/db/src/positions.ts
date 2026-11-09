import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * Keys longer than this trigger a rebalance of the column. A key grows by roughly one
 * character per few "insert between the same two neighbours" operations, so this cap is
 * reached only after hundreds of such moves.
 */
export const MAX_POSITION_LENGTH = 64;

/** A key strictly between `before` and `after` (either may be null for "no neighbour"). */
export const keyBetween = (before: string | null, after: string | null): string =>
  generateKeyBetween(before, after);

/** `count` short, evenly spaced keys in ascending order, used to rebalance a column. */
export const evenlySpacedKeys = (count: number): string[] =>
  generateNKeysBetween(null, null, count);

export const isPositionTooLong = (key: string): boolean => key.length > MAX_POSITION_LENGTH;
