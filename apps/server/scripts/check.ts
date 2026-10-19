// Unit check for crypto, the SQLite store (users, sign-in links, sessions), settings, the URL guard and the rate limiter. Run: npm run check
import "../src/env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallPlanSchema, EmailSchema } from "@ai-caller/shared";
import { RateLimiter, readCookie } from "../src/auth.js";
import { loadEncryptionKey, makeCipher, maskValue, safeEqual } from "../src/crypto.js";
import { Store } from "../src/db.js";
import { assertPublicUrl, isPrivateAddress } from "../src/netguard.js";
import { applySettingsUpdate, getSettings, settingsView } from "../src/settings.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicaller-check-"));
try {
  // Encryption key: created once, stable, env override validated, damaged file never overwritten.
  const key = loadEncryptionKey(dir, {});
  assert.equal(loadEncryptionKey(dir, {}), key);
  assert.equal(Buffer.from(key, "base64").length, 32);
  const envKey = Buffer.alloc(32, 7).toString("base64");
  assert.equal(loadEncryptionKey(dir, { ENCRYPTION_KEY: envKey }), envKey);
  assert.throws(() => loadEncryptionKey(dir, { ENCRYPTION_KEY: "short" }), /32 random bytes/);
  const badDir = path.join(dir, "bad");
  fs.mkdirSync(badDir);
  fs.writeFileSync(path.join(badDir, "secrets.json"), JSON.stringify({ encryptionKey: "y" }));
  assert.throws(() => loadEncryptionKey(badDir, {}), /damaged/);
  assert.ok(safeEqual("abc", "abc") && !safeEqual("abc", "abd") && !safeEqual("abc", "abcd"));

  // AES-256-GCM: round trip, random IV, tamper detection.
  const cipher = makeCipher(key);
  const enc = cipher.encrypt("4111 1111 1111 1234");
  assert.equal(cipher.decrypt(enc), "4111 1111 1111 1234");
  assert.notEqual(cipher.encrypt("x"), cipher.encrypt("x"));
  const tampered = Buffer.from(enc, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => cipher.decrypt(tampered.toString("base64")));
  assert.equal(maskValue("1234567890"), "••••7890");
  assert.equal(maskValue("1234567"), "••••");

  // Users, invites, single-use expiring sign-in links, sessions.
  const store = new Store(dir, cipher);
  assert.equal(store.db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(store.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  assert.equal(EmailSchema.parse("  Alex@Example.COM "), "alex@example.com");
  assert.ok(!EmailSchema.safeParse("not an email").success);
  const alex = store.createUser("alex@example.com", false);
  assert.throws(() => store.createUser("alex@example.com", false), /UNIQUE/);
  store.addInvite("sam@example.com", alex.id);
  assert.ok(store.hasInvite("sam@example.com") && !store.hasInvite("nobody@example.com"));
  assert.deepEqual(store.pendingInvites().map((i) => i.email), ["sam@example.com"]);
  const link = store.createLoginToken("sam@example.com", 60_000);
  assert.ok(!JSON.stringify(store.db.prepare("SELECT * FROM login_tokens").all()).includes(link), "only the token hash is stored");
  assert.equal(store.consumeLoginToken(link), "sam@example.com");
  assert.equal(store.consumeLoginToken(link), null, "a sign-in link works once");
  const old = store.createLoginToken("sam@example.com", -1);
  assert.equal(store.consumeLoginToken(old), null, "an expired link is refused");
  const sid = store.createSession(alex.id, 60_000);
  assert.equal(store.sessionUser(sid)?.email, "alex@example.com");
  assert.equal(store.sessionUser("wrong"), null);
  store.deleteSession(sid);
  assert.equal(store.sessionUser(sid), null);
  assert.equal(store.sessionUser(store.createSession(alex.id, -1)), null, "an expired session is refused");
  assert.equal(readCookie("a=1; aic_session=abc%3D; b=2", "aic_session"), "abc=");
  assert.equal(readCookie(undefined, "aic_session"), null);

  // Stored details are encrypted at rest and masked in the list.
  const uid = alex.id;
  store.updateProfile(uid, { name: "Alex Doe" });
  store.setDetail(uid, "account_number", "ACCT-99887766");
  assert.deepEqual(
    store.listDetails(uid).map((d) => [d.key, d.masked]),
    [["account_number", "••••7766"]],
  );
  const raw = String(store.db.prepare("SELECT value_enc FROM account_details").get()?.value_enc);
  assert.ok(!raw.includes("99887766"));
  assert.equal(store.getDetailValue(uid, "account_number"), "ACCT-99887766");
  assert.equal(store.getDetailValue("someone-else", "account_number"), null);

  // Calls, approvals, live-call counts, stale live calls fail at startup.
  const plan = CallPlanSchema.parse({ company: "Acme", phoneNumber: "+18005550100", issue: "Double charge", desiredOutcome: "Refund" });
  assert.equal(plan.maxHoldMinutes, 45);
  assert.equal(plan.disclosure, true);
  const call = store.createCall(uid, plan);
  assert.equal(call.status, "draft");
  store.setStatus(call.id, "on_hold");
  assert.equal(store.countLiveCalls(uid), 1);
  assert.equal(store.countLiveCalls(null), 1);
  assert.equal(store.countLiveCalls("someone-else"), 0);
  const ap = store.createApproval(uid, call.id, "Accept $20 credit?", ["yes", "no"]);
  assert.equal(store.resolveApproval(ap.id, "approved", null)?.status, "approved");
  assert.equal(store.resolveApproval(ap.id, "denied", null), null, "a resolved approval cannot change");
  store.createApproval(uid, call.id, "Second?", []);
  assert.equal(store.failStaleLiveCalls(), 1);
  assert.equal(store.getCall(uid, call.id)?.status, "failed");
  assert.ok(store.listApprovals(call.id).every((a) => a.status !== "pending"));
  assert.equal(store.getCall("someone-else", call.id), null);

  // Settings: saved value, else default; no environment fallback; keys encrypted and never in the view.
  process.env.LLM_MODEL = "env-model";
  process.env.LLM_API_KEY = "sk-env-must-not-leak";
  let s = getSettings(store, uid);
  assert.equal(s.callModel, "", "environment variables are not shared with users");
  assert.equal(s.apiKey, "");
  assert.equal(s.approvalTimeoutSeconds, 180);
  assert.equal(settingsView(s).configured, false);
  applySettingsUpdate(store, uid, { provider: "groq", callModel: "saved-model", apiKey: "sk-secret-123456" });
  s = getSettings(store, uid);
  assert.equal(s.callModel, "saved-model");
  const view = settingsView(s);
  assert.equal(view.hasApiKey, true);
  assert.equal(view.configured, true);
  assert.equal(view.effectiveBaseUrl, "https://api.groq.com/openai/v1");
  assert.ok(!JSON.stringify(view).includes("sk-secret"));
  assert.ok(!store.getSettingsRaw(uid).apiKey.includes("sk-secret"));
  applySettingsUpdate(store, uid, { webSearch: false });
  assert.equal(getSettings(store, uid).apiKey, "sk-secret-123456", "omitted fields stay unchanged");
  applySettingsUpdate(store, uid, { apiKey: "" });
  assert.equal(getSettings(store, uid).apiKey, "");
  assert.equal(getSettings(store, store.createUser("other@example.com", false).id).callModel, "", "settings are per user");

  // URL guard: https only, public addresses only.
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "nonsense"])
    assert.ok(isPrivateAddress(ip), `${ip} is private`);
  for (const ip of ["8.8.8.8", "104.18.2.3", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.ok(!isPrivateAddress(ip), `${ip} is public`);
  const fakeDns = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];
  await assertPublicUrl("https://api.example.com/v1", fakeDns({ "api.example.com": ["93.184.216.34"] }));
  await assert.rejects(assertPublicUrl("http://api.example.com/v1", fakeDns({ "api.example.com": ["93.184.216.34"] })), /https/);
  await assert.rejects(assertPublicUrl("https://rebind.example/v1", fakeDns({ "rebind.example": ["93.184.216.34", "10.0.0.5"] })), /private/);
  await assert.rejects(assertPublicUrl("https://127.0.0.1:11434/v1"), /private/);
  await assert.rejects(assertPublicUrl("https://[::1]/v1"), /private/);
  await assert.rejects(assertPublicUrl("https://user:pw@api.example.com/"), /user name/);
  await assert.rejects(assertPublicUrl("https://nxdomain.invalid/", fakeDns({})), /resolve/);
  await assert.rejects(assertPublicUrl("not a url"), /valid URL/);

  // Rate limiter: max hits per window, then refuses until the window moves.
  const rl = new RateLimiter();
  assert.ok(rl.allow("k", 2, 1000, 0) && rl.allow("k", 2, 1000, 10));
  assert.ok(!rl.allow("k", 2, 1000, 20));
  assert.ok(rl.allow("k", 2, 1000, 1011), "old hits leave the window");
  assert.ok(rl.allow("other", 2, 1000, 20), "keys are separate");

  // Deleting a user removes all their rows.
  assert.ok(store.deleteUser(uid));
  for (const table of ["calls", "approvals", "transcript_entries", "account_details", "settings", "sessions", "audit_events", "playbooks"])
    assert.equal(Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(uid)?.n), 0, `${table} cleared`);

  // Data survives reopening; an old exe data folder is refused.
  store.close();
  const reopened = new Store(dir, makeCipher(loadEncryptionKey(dir, {})));
  assert.equal(reopened.getUserByEmail("other@example.com")?.email, "other@example.com");
  reopened.close();
  const oldDir = path.join(dir, "old");
  fs.mkdirSync(oldDir);
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const oldDb = new DatabaseSync(path.join(oldDir, "aicaller.db"));
  oldDb.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, callback_phone TEXT, created_at TEXT)");
  oldDb.close();
  assert.throws(() => new Store(oldDir, cipher), /old AICaller\.exe/);
  console.log("check: all assertions passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
