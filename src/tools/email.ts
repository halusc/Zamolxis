import { ImapFlow } from 'imapflow';

/**
 * READ-ONLY inbox access for the `read_email` tool. Connects via IMAP and returns message
 * envelopes (sender / subject / date) for unread or recent mail. It NEVER sends, replies,
 * deletes, or marks messages as read — it fetches ENVELOPE only (which does not set the
 * \Seen flag), so your inbox is untouched. Credentials come from the same EMAIL_* env vars
 * as the email channel, but enabling this tool does NOT enable the auto-replying channel.
 */
export interface InboxItem {
  from: string;
  subject: string;
  date: string;
}

export function emailConfigured(): boolean {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD && process.env.EMAIL_IMAP_HOST);
}

export async function readInbox(opts: { unreadOnly?: boolean; limit?: number; search?: string }): Promise<InboxItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const client = new ImapFlow({
    host: process.env.EMAIL_IMAP_HOST as string,
    port: Number(process.env.EMAIL_IMAP_PORT ?? 993),
    secure: true,
    auth: { user: process.env.EMAIL_USER as string, pass: process.env.EMAIL_PASSWORD as string },
    logger: false,
  });
  const out: InboxItem[] = [];
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const criteria = opts.unreadOnly === false ? { all: true } : { seen: false };
    const uids = (await client.search(criteria, { uid: true })) || [];
    const pick = uids.slice(-limit).reverse(); // newest first
    if (pick.length) {
      // ENVELOPE-only fetch: returns headers without setting \Seen, so the inbox is unchanged.
      for await (const msg of client.fetch(pick.join(','), { envelope: true }, { uid: true })) {
        const env = msg.envelope;
        const f = env?.from?.[0];
        const from = (f?.name || f?.address || '(unknown sender)').trim();
        const subject = (env?.subject || '(no subject)').trim();
        const date = env?.date ? new Date(env.date).toISOString() : '';
        if (opts.search && !`${from} ${subject}`.toLowerCase().includes(opts.search.toLowerCase())) continue;
        out.push({ from, subject, date });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out;
}
