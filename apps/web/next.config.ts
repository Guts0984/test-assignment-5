import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const config: NextConfig = {
  // A self-contained server in .next/standalone: the runtime image carries no node_modules tree.
  output: 'standalone',
  // The monorepo root, so the standalone build includes the workspace packages it imports.
  outputFileTracingRoot: root,
  // packages/shared exports TypeScript source; Next compiles it with the app.
  transpilePackages: ['@kanban/shared'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Secrets are read by server code from the .env file (src/shared/lib/env.server.ts), never
  // through process.env, so nothing is inlined into the browser bundle.
};

export default config;
