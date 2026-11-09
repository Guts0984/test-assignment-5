import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../src/password';

describe('password hashing', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts: the same password never produces the same hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('handles unicode and very long passwords', async () => {
    const long = 'пароль-密码-🔑'.repeat(500);
    const hash = await hashPassword(long);
    expect(await verifyPassword(long, hash)).toBe(true);
    expect(await verifyPassword(long.slice(0, -1), hash)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['wrong scheme', 'bcrypt$32768$8$1$c2FsdA==$aGFzaA=='],
    ['missing parts', 'scrypt$32768$8'],
    ['non-power-of-two cost', 'scrypt$30000$8$1$c2FsdA==$aGFzaA=='],
    ['absurd cost that would exhaust memory', `scrypt$${2 ** 30}$8$1$c2FsdA==$aGFzaA==`],
    ['garbage', 'not a hash at all'],
  ])(
    'treats a malformed stored hash (%s) as a failed login, never as an error',
    async (_n, stored) => {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    },
  );
});
