'use client';

import { useRouter } from 'next/navigation';

import { CardDetail } from '@/features/cards';
import { Modal } from '@/shared/ui/dialog';

export const CardModal = ({ boardId, cardId }: { boardId: string; cardId: string }) => {
  const router = useRouter();
  return (
    <Modal title="Card" onClose={() => router.back()}>
      <CardDetail boardId={boardId} cardId={cardId} onDeleted={() => router.back()} />
    </Modal>
  );
};
