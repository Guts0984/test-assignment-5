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
  rateLimit: { perMinute: number; authPerMinute: number };
};
