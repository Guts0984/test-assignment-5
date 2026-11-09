import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { server } from './support/msw';

// Node's fetch needs absolute URLs; the app calls relative ones (/api/...), as a browser does.
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
  nodeFetch(
    typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input,
    init,
  );

// `server-only` throws outside a server build; in tests the modules that use it are exercised directly.
vi.mock('server-only', () => ({}));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());
