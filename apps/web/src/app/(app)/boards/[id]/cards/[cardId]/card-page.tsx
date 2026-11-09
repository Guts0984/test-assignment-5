'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { CardDetail } from '@/features/cards';

export const CardPage = ({ boardId, cardId }: { boardId: string; cardId: string }) => {
  const router = useRouter();
  return (
    <main className="mx-auto grid max-w-2xl gap-4 p-6">
      <Link href={`/boards/${boardId}`} prefetch={false} className="text-sm underline">
        ← Back to the board
      </Link>
      <h1 className="text-2xl font-semibold">Card</h1>
      <CardDetail
        boardId={boardId}
        cardId={cardId}
        onDeleted={() => router.push(`/boards/${boardId}`)}
      />
    </main>
  );
};
