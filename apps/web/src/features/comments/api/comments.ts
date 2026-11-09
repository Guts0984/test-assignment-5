import type { Comment } from '@kanban/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, describeError } from '@/shared/lib/client-api';
import { toast } from '@/shared/ui/toaster';

export const commentsKey = (cardId: string) => ['comments', cardId] as const;

export const useComments = (cardId: string) =>
  useQuery({
    queryKey: commentsKey(cardId),
    queryFn: () => api<Comment[]>(`/cards/${cardId}/comments`),
  });

export const useAddComment = (cardId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api<Comment>(`/cards/${cardId}/comments`, { json: { body } }),
    onSuccess: (comment) =>
      // The socket echo of this comment may already be in the list: never show it twice.
      client.setQueryData<Comment[]>(commentsKey(cardId), (current = []) =>
        current.some((c) => c.id === comment.id) ? current : [...current, comment],
      ),
    onError: (error) => toast(`The comment could not be added. ${describeError(error)}`, 'error'),
  });
};
