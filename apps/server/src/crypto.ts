import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The data folder: DATA_DIR, default ./data. */
export function resolveDataDir(): string {
  const dir = path.resolve(process.env.DATA_DIR || "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const validKey = (k: string | undefined) => Buffer.from(k ?? "", "base64").length === 32;

/** The AES key: ENCRYPTION_KEY (base64, 32 bytes) if set, else secrets.json in the data folder, created on first run. */
export function loadEncryptionKey(dataDir: string, env = process.env): string {
  if (env.ENCRYPTION_KEY) {
    if (!validKey(env.ENCRYPTION_KEY)) throw new Error("ENCRYPTION_KEY must be 32 random bytes in base64 (openssl rand -base64 32).");
    return env.ENCRYPTION_KEY;
  }
  const file = path.join(dataDir, "secrets.json");
  if (!fs.existsSync(file)) {
    const key = randomBytes(32).toString("base64");
    fs.writeFileSync(file, JSON.stringify({ encryptionKey: key }, null, 2), { mode: 0o600, flag: "wx" });
    return key;
  }
  // Refuse to replace a damaged file: a new key would make stored details and API keys unreadable.
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { encryptionKey?: string };
  if (!validKey(parsed.encryptionKey)) throw new Error(`${file} is damaged. Restore it from a backup.`);
  return parsed.encryptionKey!;
}

export interface Cipher {
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

/** AES-256-GCM, stored as base64(iv | tag | ciphertext). */
export function makeCipher(keyB64: string): Cipher {
  const key = Buffer.from(keyB64, "base64");
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    },
    decrypt(encoded) {
      const buf = Buffer.from(encoded, "base64");
      const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
    },
  };
}

export function maskValue(value: string): string {
  return value.length >= 8 ? `••••${value.slice(-4)}` : "••••";
}

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
