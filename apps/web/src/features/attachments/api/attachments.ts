import type { Attachment, CreateAttachmentResponse, DownloadLink } from '@kanban/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api, describeError } from '@/shared/lib/client-api';
import { toast } from '@/shared/ui/toaster';
import { checkFile } from '../model/validate-file';
import { uploadWithProgress } from './upload';

export const attachmentsKey = (cardId: string) => ['attachments', cardId] as const;

export const useAttachments = (cardId: string) =>
  useQuery({
    queryKey: attachmentsKey(cardId),
    queryFn: () => api<Attachment[]>(`/cards/${cardId}/attachments`),
  });

export type UploadState = { fileName: string; progress: number } | null;

/** register -> upload with progress -> complete; the server checks the real type at `complete`. */
export const useUpload = (cardId: string) => {
  const client = useQueryClient();
  const [state, setState] = useState<UploadState>(null);
  const upload = async (file: File): Promise<void> => {
    const problem = checkFile(file);
    if (problem) return void toast(problem, 'error');
    setState({ fileName: file.name, progress: 0 });
    try {
      const created = await api<CreateAttachmentResponse>(`/cards/${cardId}/attachments`, {
        json: { fileName: file.name, contentType: file.type, sizeBytes: file.size },
      });
      await uploadWithProgress(created.upload, file, (progress) =>
        setState({ fileName: file.name, progress }),
      );
      await api(`/attachments/${created.attachment.id}/complete`, { method: 'POST' });
      await client.invalidateQueries({ queryKey: attachmentsKey(cardId) });
    } catch (error) {
      toast(
        error instanceof Error && !('status' in error)
          ? error.message
          : `The file could not be attached. ${describeError(error)}`,
        'error',
      );
    } finally {
      setState(null);
    }
  };
  return { state, upload };
};

export const openDownload = async (attachmentId: string): Promise<void> => {
  try {
    const link = await api<DownloadLink>(`/attachments/${attachmentId}/download`);
    window.location.assign(link.url); // a signed link that works for five minutes
  } catch (error) {
    toast(`The file could not be downloaded. ${describeError(error)}`, 'error');
  }
};
