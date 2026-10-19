export type Mailer = (to: string, subject: string, text: string) => Promise<void>;

/** Sends through Resend when RESEND_API_KEY and MAIL_FROM are set; otherwise prints the message to the console (dev). */
export function defaultMailer(env = process.env): { send: Mailer; configured: boolean } {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!key || !from) {
    return {
      configured: false,
      send: async (to, subject, text) => console.log(`\n[mail not configured] To: ${to}\nSubject: ${subject}\n${text}\n`),
    };
  }
  return {
    configured: true,
    send: async (to, subject, text) => {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}
