import { NextResponse, type NextRequest } from 'next/server';

/**
 * Sends visitors without a session cookie to the login page before any page work happens.
 *
 * It deliberately makes NO calls to the API: it only looks at whether the cookie exists. The
 * session is really checked (and the visitor's address vouched for) by the server-side loaders in
 * src/shared/lib/server-api.ts, so there is nothing here that could be counted against the web
 * server's own address.
 */
const PUBLIC_PREFIXES = [
  '/login',
  '/register',
  '/invite/',
  '/healthz',
  '/slow-down',
  '/_next',
  '/favicon',
];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();
  if (request.cookies.has('sid')) return NextResponse.next();
  const login = new URL('/login', request.url);
  login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = { matcher: ['/((?!api|socket.io|_next/static|_next/image).*)'] };
