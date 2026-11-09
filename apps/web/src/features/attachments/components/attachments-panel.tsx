'use client';

import { ALLOWED_CONTENT_TYPES } from '@kanban/shared';
import { Paperclip } from 'lucide-react';
import { useId } from 'react';

import { Button } from '@/shared/ui/button';
import { openDownload, useAttachments, useUpload } from '../api/attachments';

const size = (bytes: number): string =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const AttachmentsPanel = ({ cardId, canUpload }: { cardId: string; canUpload: boolean }) => {
  const files = useAttachments(cardId);
  const { state, upload } = useUpload(cardId);
  const inputId = useId();
  return (
    <section aria-labelledby={`attachments-${cardId}`} className="grid gap-3">
      <h3 id={`attachments-${cardId}`} className="font-semibold">
        Attachments
      </h3>
      {files.isPending ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          Loading attachments…
        </p>
      ) : null}
      {files.isError ? (
        <p role="alert" className="text-sm text-danger">
          Attachments could not be loaded.
        </p>
      ) : null}
      {files.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No attachments.</p>
      ) : null}
      <ul className="grid gap-2">
        {files.data?.map((file) => (
          <li
            key={file.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
          >
            <span className="min-w-0 truncate">
              <Paperclip className="mr-1 inline h-3.5 w-3.5" aria-hidden />
              {file.fileName}{' '}
              <span className="text-muted-foreground">({size(file.sizeBytes)})</span>
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void openDownload(file.id)}
              aria-label={`Download ${file.fileName}`}
            >
              Download
            </Button>
          </li>
        ))}
      </ul>
      {state ? (
        <div role="status" className="grid gap-1 text-sm">
          <label htmlFor={`${inputId}-progress`}>
            Uploading {state.fileName}… {Math.round(state.progress * 100)}%
          </label>
          <progress id={`${inputId}-progress`} value={state.progress} max={1} className="w-full" />
        </div>
      ) : null}
      {canUpload ? (
        <div>
          <label htmlFor={inputId} className="mb-1 block text-sm font-medium">
            Attach an image or PDF (up to 10 MB)
          </label>
          <input
            id={inputId}
            type="file"
            accept={ALLOWED_CONTENT_TYPES.join(',')}
            disabled={state !== null}
            className="text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void upload(file);
            }}
          />
        </div>
      ) : null}
    </section>
  );
};
