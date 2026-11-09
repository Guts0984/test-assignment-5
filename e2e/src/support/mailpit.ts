import { MAILPIT_URL } from './env';

type Message = { ID: string; Subject: string; To: { Address: string }[] };

export const messagesTo = async (address: string): Promise<Message[]> => {
  const response = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=50`,
  );
  return ((await response.json()) as { messages: Message[] }).messages;
};

/** Waits for the first email to `address` (the worker sends within a few seconds). */
export const waitForEmail = async (
  address: string,
  timeoutMs = 30_000,
): Promise<{ subject: string; text: string }> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [first] = await messagesTo(address);
    if (first) {
      const detail = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${first.ID}`)).json()) as {
        Text: string;
        Subject: string;
      };
      return { subject: detail.Subject, text: detail.Text };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no email arrived for ${address} within ${timeoutMs / 1000}s`);
};
