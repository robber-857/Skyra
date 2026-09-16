import { z } from "zod";

export type TransactionalMail = {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
};
export type MailOutcome =
  | { status: "ACCEPTED"; messageId: string }
  | { status: "FAILED" }
  | { status: "UNKNOWN" };

// Optional transport, disabled until the operator explicitly configures it.
// This does not provision an account, verify DNS or send using Shopify settings.
export function transactionalMailReady() {
  return (
    process.env.SKYRA_MAIL_ENABLED === "true" &&
    process.env.SKYRA_MAIL_PROVIDER === "resend" &&
    Boolean(process.env.RESEND_API_KEY) &&
    z.email().safeParse(process.env.SKYRA_MAIL_FROM).success
  );
}

export async function sendTransactionalMail(
  mail: TransactionalMail,
  send: typeof fetch = fetch,
): Promise<MailOutcome> {
  if (!transactionalMailReady() || !z.email().safeParse(mail.to).success)
    return { status: "FAILED" };
  try {
    const response = await send("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": mail.idempotencyKey,
      },
      body: JSON.stringify({
        from: process.env.SKYRA_MAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
    });
    if (!response.ok)
      return { status: response.status >= 500 ? "UNKNOWN" : "FAILED" };
    const body = z
      .object({ id: z.string().min(1).max(200) })
      .safeParse(await response.json());
    return body.success
      ? { status: "ACCEPTED", messageId: body.data.id }
      : { status: "UNKNOWN" };
  } catch {
    // No automatic retry after ambiguous acceptance, including a timeout.
    return { status: "UNKNOWN" };
  }
}
