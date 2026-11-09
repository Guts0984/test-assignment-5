import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt from Node's standard library (no native dependency).
 * Stored format: `scrypt$N$r$p$salt$hash` (base64), so parameters can be raised later and old
 * hashes keep verifying with the parameters they were created with.
 */
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const MAX_MEMORY = 128 * 1024 * 1024;

const derive = (password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...options, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
};

const parse = (stored: string) => {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return undefined;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const valid =
    Number.isInteger(Math.log2(params.N)) &&
    params.N >= 2 ** 10 &&
    params.N <= 2 ** 20 &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    params.r <= 32 &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    params.p <= 16;
  if (!valid) return undefined;
  return { params, salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
};

/** Constant-time check. Returns false (never throws) for a wrong password or a malformed hash. */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
};
