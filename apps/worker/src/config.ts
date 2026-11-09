/** Everything the worker needs from its environment, already validated. */
export type WorkerConfig = {
  postgres: { user: string; password: string; database: string; host: string; port: number };
  redis: { host: string; port: number; password: string };
  s3: { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string };
  smtp: { host: string; port: number; from: string };
  /** Public address of the site, used for the links inside emails. */
  appOrigin: string;
  healthPort: number;
  /** BullMQ key prefix; tests use a private one so they cannot see each other's jobs. */
  queuePrefix: string;
  timing: {
    /** How often pending emails and unclaimed mentions are looked for. */
    scanIntervalMs: number;
    /** How often unfinished uploads and files of deleted cards are cleaned up. */
    cleanupIntervalMs: number;
    /** Mentions arriving within this time of the first one go into the same digest. */
    digestCollectMs: number;
    /** A user gets at most one digest per this time (15 minutes). */
    digestMinIntervalMs: number;
    /** An upload that was never completed is removed after this time (one hour). */
    uploadMaxAgeMs: number;
    /** First retry delay for a failed send; doubles after every attempt. */
    retryBackoffMs: number;
  };
};
