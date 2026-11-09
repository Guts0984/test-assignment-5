import { CardModal } from './card-modal';

// Clicking a card on the board lands here: the card opens in a modal ON TOP of the board.
export default async function InterceptedCardPage({
  params,
}: {
  params: Promise<{ id: string; cardId: string }>;
}) {
  const { id, cardId } = await params;
  return <CardModal boardId={id} cardId={cardId} />;
}
