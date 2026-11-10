/** Everything the application needs from its environment, already validated. */
export type AppConfig = {
  port: number;
  /** The one public origin of the web app; cross-site writes from any other origin are refused. */
  appOrigin: string;
  session: { cookieSecure: boolean; ttlSeconds: number };
  inviteTtlSeconds: number;
  postgres: { user: string; password: string; database: string; host: string; port: number };
  redis: { host: string; port: number; password: string };
  s3: {
    endpoint: string;
    /** Origin that browsers use to reach object storage (pre-signed URLs point here). */
    publicUrl: string;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
  };
  /** How long a download link stays valid. */
  downloadLinkTtlSeconds: number;
  /**
   * Shared with the Next.js server only: lets it vouch for the visitor's address when it calls
   * the API on the visitor's behalf (see packages/shared/src/client-ip.ts).
   */
  clientIpSecret: string;
  rateLimit: {
    perMinute: number;
    authPerMinute: number;
    /** Socket.IO: new connections per address per minute, shared by all API instances. */
    wsConnectsPerMinute: number;
    /** Socket.IO: messages per address per 10 seconds over ALL its connections, shared by all instances. */
    wsMessagesPer10s: number;
    /**
     * Socket.IO: board.join (builds a whole board snapshot) per address, and per user, per 10
     * seconds over ALL their connections, shared by all instances.
     */
    wsJoinsPer10s: number;
    /** Socket.IO: simultaneous connections per address on one instance. */
    wsMaxConnectionsPerIp: number;
  };
};
