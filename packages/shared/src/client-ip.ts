/**
 * Passing the visitor's address from the Next.js server to the API.
 *
 * Browser requests reach the API through nginx, which sets `X-Real-IP` from the connection it
 * accepted. Requests made by the Next.js server itself (server components, server actions,
 * middleware) do not pass through nginx, so the API would only see the web server's address and
 * put every visitor into ONE rate-limit bucket. The web server therefore attaches the visitor's
 * address, signed with a secret only the web server and the API know. The API believes the header
 * only if the signature is valid, so a browser cannot pick its own address.
 */

export const CLIENT_IP_HEADER = 'x-client-ip';
export const CLIENT_IP_SIGNATURE_HEADER = 'x-client-ip-signature';

/** A signature is accepted for this long; it only needs to survive one internal request. */
const MAX_AGE_MS = 60_000;

const encoder = new TextEncoder();

/** Plausible IPv4 / IPv6 text; the signature is what makes a value trustworthy. */
export const looksLikeIp = (value: string): boolean =>
  value.length <= 45 &&
  (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) ||
    (value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value)));

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

const keyFor = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);

/** Headers to add to a request made on behalf of the visitor at `ip`. */
export const signClientIp = async (
  secret: string,
  ip: string,
  now: number = Date.now(),
): Promise<Record<string, string>> => {
  const timestamp = String(now);
  const mac = await crypto.subtle.sign(
    'HMAC',
    await keyFor(secret, 'sign'),
    encoder.encode(`${timestamp}.${ip}`),
  );
  return { [CLIENT_IP_HEADER]: ip, [CLIENT_IP_SIGNATURE_HEADER]: `${timestamp}.${toHex(mac)}` };
};

/**
 * The visitor's address if the headers carry a valid, fresh signature; otherwise undefined
 * (and the caller falls back to other, less trusted sources).
 */
export const verifyClientIp = async (
  secret: string,
  ip: string | undefined,
  signature: string | undefined,
  now: number = Date.now(),
): Promise<string | undefined> => {
  if (!ip || !signature || !looksLikeIp(ip)) return undefined;
  const [timestamp, hex, ...extra] = signature.split('.');
  if (extra.length > 0 || !timestamp || !hex || !/^\d{10,16}$/.test(timestamp)) return undefined;
  if (Math.abs(now - Number(timestamp)) > MAX_AGE_MS) return undefined;
  const mac = fromHex(hex);
  if (!mac) return undefined;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await keyFor(secret, 'verify'),
    mac,
    encoder.encode(`${timestamp}.${ip}`),
  );
  return valid ? ip : undefined;
};
