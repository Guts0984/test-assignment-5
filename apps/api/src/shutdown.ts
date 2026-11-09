import type { INestApplication } from '@nestjs/common';

export type ShutdownOptions = {
  /** Hard limit: if draining takes longer, exit with a failure code. */
  timeoutMs: number;
  exit: (code: number) => void;
  log: (message: string) => void;
};

/**
 * Stops accepting connections, lets requests that are already running finish, closes
 * PostgreSQL / Redis / S3, then exits with 0. Calling it again while it runs does nothing.
 * (Nest's own shutdown hooks re-send the signal after cleanup, which ends the process with a
 * non-zero code, so the exit code is controlled here instead.)
 */
export const createShutdown = (app: INestApplication, options: ShutdownOptions) => {
  let running: Promise<void> | undefined;
  return (signal: string): Promise<void> => {
    running ??= (async () => {
      options.log(`${signal} received, draining`);
      const timer = setTimeout(() => {
        options.log('shutdown timed out');
        options.exit(1);
      }, options.timeoutMs);
      try {
        await app.close();
        options.log('shutdown complete');
        clearTimeout(timer);
        options.exit(0);
      } catch (error) {
        clearTimeout(timer);
        options.log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        options.exit(1);
      }
    })();
    return running;
  };
};
