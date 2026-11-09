import { describe, expect, it } from 'vitest';

import {
  evenlySpacedKeys,
  isPositionTooLong,
  keyBetween,
  MAX_POSITION_LENGTH,
} from '../src/positions';

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe('positions', () => {
  it('generates a key strictly between two neighbours', () => {
    const key = keyBetween('a0', 'a1');
    expect(key > 'a0').toBe(true);
    expect(key < 'a1').toBe(true);
  });

  it('supports open ends', () => {
    expect(keyBetween(null, null)).toBeTruthy();
    expect(keyBetween('a0', null) > 'a0').toBe(true);
    expect(keyBetween(null, 'a0') < 'a0').toBe(true);
  });

  it('produces evenly spaced keys that are strictly ascending and short', () => {
    const keys = evenlySpacedKeys(1000);
    expect(keys).toHaveLength(1000);
    expect([...keys].sort(byteOrder)).toEqual(keys);
    expect(new Set(keys).size).toBe(1000);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(4);
  });

  it('only uses characters allowed by the database CHECK', () => {
    const keys = [...evenlySpacedKeys(500), keyBetween('a0', 'a1'), keyBetween(null, 'a0')];
    for (const key of keys) expect(key).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('flags keys over the length cap', () => {
    expect(isPositionTooLong('a'.repeat(MAX_POSITION_LENGTH))).toBe(false);
    expect(isPositionTooLong('a'.repeat(MAX_POSITION_LENGTH + 1))).toBe(true);
  });
});
