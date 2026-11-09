import { ALLOWED_CONTENT_TYPES, LIMITS } from '@kanban/shared';

/** Catches the obvious problems in the browser, before anything is uploaded. The server re-checks the content. */
export const checkFile = (file: { name: string; size: number; type: string }): string | null => {
  if (file.size === 0) return 'That file is empty.';
  if (file.size > LIMITS.attachmentBytes) return 'Files can be at most 10 MB.';
  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.type))
    return 'Only images (PNG, JPEG, GIF, WebP) and PDF files can be attached.';
  if (/[/\\]/.test(file.name)) return 'The file name must not contain slashes.';
  return null;
};
