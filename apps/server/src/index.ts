import "./env.js";
import { EmailSchema } from "@ai-caller/shared";
import { loadEncryptionKey, makeCipher, resolveDataDir } from "./crypto.js";
import { Store } from "./db.js";
import { Hub } from "./events.js";
import { buildApp } from "./http.js";
import { defaultMailer } from "./mail.js";
import { setAllowPrivateUrls } from "./netguard.js";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set. See deploy/aicaller.env.example.`);
  return v;
}

async function main() {
  const publicUrl = new URL(required("PUBLIC_URL")).origin;
  const adminEmail = EmailSchema.parse(required("ADMIN_EMAIL"));
  const dataDir = resolveDataDir();
  const store = new Store(dataDir, makeCipher(loadEncryptionKey(dataDir)));
  const stale = store.failStaleLiveCalls();
  const mail = defaultMailer();
  if (process.env.AICALLER_UNSAFE_ALLOW_PRIVATE_URLS === "1") {
    setAllowPrivateUrls(true);
    console.warn("WARNING: AICALLER_UNSAFE_ALLOW_PRIVATE_URLS=1 lets users point the server at local and private addresses. Development only.");
  }
  const app = await buildApp({ store, hub: new Hub(), publicUrl, adminEmail, mailer: mail.send });
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT) || 4317;
  await app.listen({ host, port });

  console.log(
    [
      `AI Caller is running on http://${host}:${port}`,
      `Public address: ${publicUrl}`,
      `Admin: ${adminEmail}`,
      `Data folder: ${dataDir}`,
      mail.configured ? "Email: Resend" : "Email: not configured; sign-in links are printed here instead (set RESEND_API_KEY and MAIL_FROM)",
      stale ? `Marked ${stale} unfinished call(s) from the last run as failed.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const stop = async () => {
    await app.close().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((err) => {
  console.error(`AI Caller could not start: ${(err as Error).message}`);
  process.exit(1);
});
