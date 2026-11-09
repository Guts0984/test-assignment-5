export const APP_CONFIG = Symbol('APP_CONFIG');
export const DATABASE = Symbol('DATABASE');
export const REDIS = Symbol('REDIS');
export const S3 = Symbol('S3');
/** S3 client configured with the public address; used only to sign links, never to make requests. */
export const S3_SIGNER = Symbol('S3_SIGNER');
