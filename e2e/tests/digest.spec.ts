import { request } from '@playwright/test';

import { addCard, apiAs, createBoard, json, workspaceId } from '../src/support/api';
import { BASE_URL, MAILPIT_URL } from '../src/support/env';
import { messagesTo, waitForEmail } from '../src/support/mailpit';
import { expect, test } from '../src/support/test';

test('five mentions of one person within a minute arrive as ONE email', async ({ browserName }) => {
  test.skip(
    browserName !== 'chromium',
    'this is backend behaviour; it does not depend on the browser',
  );
  test.setTimeout(170_000); // the real collection window is a minute unless .env shortens it

  const owner = await apiAs('alice');
  const wsId = await workspaceId(owner);
  const board = await createBoard(owner, 'digest');
  const card = await addCard(owner, board.id, board.columns[0]!.id, 'Mentions here');

  const email = `digest-${Date.now().toString(36)}@example.com`;
  const handle = `digest${Date.now().toString(36)}`.slice(0, 30);
  const person = await request.newContext({ baseURL: BASE_URL });
  await json(
    await person.post('/api/auth/register', {
      data: { email, handle, name: 'Digest Target', password: 'e2e-long-password-1' },
    }),
  );
  await json(
    await owner.post(`/api/workspaces/${wsId}/invites`, { data: { email, role: 'editor' } }),
  );
  const [invite] = await json<{ id: string }[]>(await person.get('/api/me/invites'));
  await json(await person.post(`/api/me/invites/${invite!.id}/accept`));
  await waitForEmail(email); // the invitation itself is an email too; it is not the digest

  for (let i = 1; i <= 5; i += 1) {
    await json(
      await owner.post(`/api/cards/${card.id}/comments`, {
        data: { body: `ping number ${i} for @${handle}` },
      }),
    );
  }

  const digest = async () => {
    for (const message of await messagesTo(email)) {
      if (!/mentioned/i.test(message.Subject)) continue;
      return {
        subject: message.Subject,
        text: (
          (await (await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}`)).json()) as {
            Text: string;
          }
        ).Text,
      };
    }
    return undefined;
  };
  await expect.poll(digest, { timeout: 120_000, intervals: [1_000] }).toBeDefined();
  const first = (await digest())!;
  expect(first.subject).toBe('You were mentioned in 5 comments');
  for (let i = 1; i <= 5; i += 1) expect(first.text).toContain(`ping number ${i}`);

  await new Promise((resolve) => setTimeout(resolve, 8_000)); // more scans happen: nothing else may be sent
  const digests = (await messagesTo(email)).filter((message) => /mentioned/i.test(message.Subject));
  expect(digests).toHaveLength(1);
  await person.dispose();
});
