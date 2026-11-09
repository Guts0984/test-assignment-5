import { CardPage } from './card-page';

// Opening the link directly (or reloading) shows the card as a page of its own.
export default async function DirectCardPage({
  params,
}: {
  params: Promise<{ id: string; cardId: string }>;
}) {
  const { id, cardId } = await params;
  return <CardPage boardId={id} cardId={cardId} />;
}
