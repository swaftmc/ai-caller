import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { exeDir, isPackaged } from "./env.js";

/** Picks the data folder: DATA_DIR, else AICaller-data beside the exe (dev: ./data), else %LOCALAPPDATA%\AICaller. */
export function resolveDataDir(): string {
  if (process.env.DATA_DIR) {
    const dir = path.resolve(process.env.DATA_DIR);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const primary = isPackaged() ? path.join(exeDir(), "AICaller-data") : path.resolve("data");
  if (isWritable(primary)) return primary;
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), process.platform === "win32" ? "AppData/Local" : ".local/share");
  const fallback = path.join(base, "AICaller");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

export interface Secrets {
  dashboardToken: string;
  encryptionKey: string;
}

/** Loads secrets.json, creating it on first run; refuses to overwrite a damaged file (it would orphan encrypted data). */
export function loadSecrets(dataDir: string): Secrets {
  const file = path.join(dataDir, "secrets.json");
  if (!fs.existsSync(file)) {
    const fresh: Secrets = {
      dashboardToken: randomBytes(32).toString("hex"),
      encryptionKey: randomBytes(32).toString("base64"),
    };
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600, flag: "wx" });
    return fresh;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Secrets>;
  if (!/^[0-9a-f]{64}$/.test(parsed.dashboardToken ?? "") || Buffer.from(parsed.encryptionKey ?? "", "base64").length !== 32) {
    throw new Error(`${file} is damaged. Restore it from a backup; deleting it makes stored details and API keys unreadable.`);
  }
  return parsed as Secrets;
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
