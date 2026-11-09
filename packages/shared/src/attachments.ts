import { z } from 'zod';

import { idSchema, LIMITS, text, timestampSchema } from './common';

/** Declared types accepted up front. The real type is detected from the file content later. */
export const ALLOWED_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const;
export const contentTypeSchema = z.enum(ALLOWED_CONTENT_TYPES);
export type AttachmentContentType = z.infer<typeof contentTypeSchema>;

export const attachmentSchema = z.object({
  id: idSchema,
  cardId: idSchema,
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(['pending', 'ready']),
  createdAt: timestampSchema,
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const createAttachmentBodySchema = z.object({
  fileName: text(1, LIMITS.fileName).refine((name) => !/[/\\]/.test(name), {
    message: 'file name must not contain path separators',
  }),
  contentType: contentTypeSchema,
  sizeBytes: z.number().int().min(1).max(LIMITS.attachmentBytes),
});
export type CreateAttachmentBody = z.infer<typeof createAttachmentBodySchema>;

/** A pre-signed form upload straight to object storage (the size limit is enforced there too). */
export const createAttachmentResponseSchema = z.object({
  attachment: attachmentSchema,
  upload: z.object({
    url: z.string(),
    /** Form fields to send, in order, before the `file` field. */
    fields: z.record(z.string(), z.string()),
  }),
});
export type CreateAttachmentResponse = z.infer<typeof createAttachmentResponseSchema>;

export const downloadLinkSchema = z.object({
  url: z.string(),
  /** Links live five minutes. */
  expiresAt: timestampSchema,
});
export type DownloadLink = z.infer<typeof downloadLinkSchema>;
