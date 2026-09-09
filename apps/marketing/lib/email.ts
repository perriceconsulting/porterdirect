/**
 * Outbound email.
 *
 * There is no mail provider configured yet, and the dangerous way to handle that is a
 * sender that quietly returns success — a password reset that reports "check your inbox"
 * while sending nothing is worse than an outage, because nobody investigates it.
 *
 * So: send through Resend when a key exists; in development, print the link to the
 * server console so the flow is exercisable; and in production with no provider,
 * THROW. A reset flow that cannot deliver must fail loudly.
 */
export interface Email {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export async function sendEmail(email: Email): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (apiKey && from) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text }),
    });
    if (!res.ok) {
      // Still never log the BODY — provider errors echo the recipient and the payload.
      // But a bare status is undiagnosable: an unverified sending domain and a revoked
      // key both arrive as 403, and those are a DNS problem and a credentials problem
      // respectively. Resend puts a machine-readable `name` on the error
      // ("validation_error", "missing_api_key"); that field carries no recipient and no
      // message content, so it is safe to surface and turns a guess into a diagnosis.
      let reason = "";
      try {
        const body = (await res.json()) as { name?: unknown };
        if (typeof body.name === "string") reason = ` [${body.name}]`;
      } catch {
        // A non-JSON error body tells us nothing safe to repeat; the status stands alone.
      }
      throw new Error(`Email provider rejected the message (HTTP ${res.status})${reason}`);
    }
    return;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No email provider configured (RESEND_API_KEY + EMAIL_FROM). Refusing to report " +
        "a delivered message that was never sent.",
    );
  }

  // Development only. This is the one place a reset URL is ever printed, and it is
  // printed to the server console — never to a response body.
  console.log(
    `\n[email:dev] no provider configured — message NOT sent\n` +
      `  to      : ${email.to}\n` +
      `  subject : ${email.subject}\n` +
      `  ${email.text.replace(/\n/g, "\n  ")}\n`,
  );
}
