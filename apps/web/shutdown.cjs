'use strict';

/**
 * Preloaded before Next's standalone server (node --require ./shutdown.cjs server.js).
 *
 * That server does not handle SIGTERM: the process would end with exit code 143 and cut requests
 * that are still running. This stops accepting connections, lets running requests finish, and
 * exits with 0. It captures the HTTP server by wrapping `createServer`, which Next calls on start.
 */
const http = require('node:http');

const servers = new Set();
const createServer = http.createServer;
http.createServer = function patched(...args) {
  const server = createServer.apply(this, args);
  servers.add(server);
  return server;
};

const log = (message) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), level: 'info', context: 'Web', message }),
  );

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, finishing running requests`);
  const timer = setTimeout(() => process.exit(1), 25_000); // never hang: fail instead
  timer.unref();
  Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections?.(); // keep-alive connections that are doing nothing
        }),
    ),
  ).then(() => {
    log('shutdown complete');
    process.exit(0);
  });
};

process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
