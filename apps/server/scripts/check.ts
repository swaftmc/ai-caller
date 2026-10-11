// Unit check for crypto, the SQLite store and settings precedence. Run: npm run check
import "../src/env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallPlanSchema } from "@ai-caller/shared";
import { loadSecrets, makeCipher, maskValue, safeEqual } from "../src/crypto.js";
import { DEFAULT_USER, Store } from "../src/db.js";
import { applySettingsUpdate, getSettings, settingsView } from "../src/settings.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicaller-check-"));
try {
  // Secrets: created once, stable across loads, correct shapes.
  const s1 = loadSecrets(dir);
  const s2 = loadSecrets(dir);
  assert.deepEqual(s1, s2);
  assert.match(s1.dashboardToken, /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(s1.encryptionKey, "base64").length, 32);
  const badDir = path.join(dir, "bad");
  fs.mkdirSync(badDir);
  fs.writeFileSync(path.join(badDir, "secrets.json"), JSON.stringify({ dashboardToken: "x", encryptionKey: "y" }));
  assert.throws(() => loadSecrets(badDir), /damaged/, "a damaged secrets.json is never overwritten");
  assert.ok(safeEqual("abc", "abc") && !safeEqual("abc", "abd") && !safeEqual("abc", "abcd"));

  // AES-256-GCM: round trip, random IV, tamper detection.
  const cipher = makeCipher(s1.encryptionKey);
  const enc = cipher.encrypt("4111 1111 1111 1234");
  assert.equal(cipher.decrypt(enc), "4111 1111 1111 1234");
  assert.notEqual(cipher.encrypt("x"), cipher.encrypt("x"));
  const tampered = Buffer.from(enc, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => cipher.decrypt(tampered.toString("base64")));
  assert.equal(maskValue("1234567890"), "••••7890");
  assert.equal(maskValue("1234567"), "••••");

  // Store: details are encrypted at rest and masked in the list.
  const store = new Store(dir, cipher);
  assert.equal(store.db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(store.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  store.updateProfile(DEFAULT_USER, { name: "Alex Doe" });
  store.setDetail(DEFAULT_USER, "account_number", "ACCT-99887766");
  assert.deepEqual(
    store.listDetails(DEFAULT_USER).map((d) => [d.key, d.masked]),
    [["account_number", "••••7766"]],
  );
  const raw = String(store.db.prepare("SELECT value_enc FROM account_details").get()?.value_enc);
  assert.ok(!raw.includes("99887766"));
  assert.equal(store.getDetailValue(DEFAULT_USER, "account_number"), "ACCT-99887766");
  assert.equal(store.getDetailValue("someone-else", "account_number"), null);

  // Calls, approvals, stale live calls fail at startup.
  const plan = CallPlanSchema.parse({
    company: "Acme",
    phoneNumber: "+18005550100",
    issue: "Double charge",
    desiredOutcome: "Refund",
  });
  assert.equal(plan.maxHoldMinutes, 45);
  assert.equal(plan.channel, "speakerphone");
  assert.equal(plan.disclosure, true);
  const call = store.createCall(DEFAULT_USER, plan);
  assert.equal(call.status, "draft");
  store.setStatus(call.id, "on_hold");
  assert.equal(store.countLiveCalls(DEFAULT_USER), 1);
  const ap = store.createApproval(DEFAULT_USER, call.id, "Accept $20 credit?", ["yes", "no"]);
  assert.equal(store.resolveApproval(ap.id, "approved", null)?.status, "approved");
  assert.equal(store.resolveApproval(ap.id, "denied", null), null, "a resolved approval cannot change");
  store.createApproval(DEFAULT_USER, call.id, "Second?", []);
  assert.equal(store.failStaleLiveCalls(), 1);
  assert.equal(store.getCall(DEFAULT_USER, call.id)?.status, "failed");
  assert.ok(store.getCall(DEFAULT_USER, call.id)?.endedAt);
  assert.ok(store.listApprovals(call.id).every((a) => a.status !== "pending"));
  assert.equal(store.getCall("someone-else", call.id), null);

  // Settings precedence: dashboard > env > default; keys encrypted and never in the view.
  process.env.LLM_MODEL = "env-model";
  process.env.LLM_PROVIDER = "groq";
  delete process.env.LLM_API_KEY;
  let s = getSettings(store, DEFAULT_USER);
  assert.equal(s.callModel, "env-model");
  assert.equal(s.provider, "groq");
  assert.equal(s.approvalTimeoutSeconds, 180);
  assert.equal(settingsView(s, false).configured, false);
  applySettingsUpdate(store, DEFAULT_USER, { callModel: "saved-model", apiKey: "sk-secret-123456" });
  s = getSettings(store, DEFAULT_USER);
  assert.equal(s.callModel, "saved-model");
  assert.equal(s.apiKey, "sk-secret-123456");
  const view = settingsView(s, false);
  assert.equal(view.hasApiKey, true);
  assert.equal(view.configured, true);
  assert.equal(view.effectiveBaseUrl, "https://api.groq.com/openai/v1");
  assert.ok(!JSON.stringify(view).includes("sk-secret"));
  const savedKey = store.getSettingsRaw(DEFAULT_USER).apiKey;
  assert.ok(savedKey && !savedKey.includes("sk-secret"));
  applySettingsUpdate(store, DEFAULT_USER, { callModel: "" });
  assert.equal(getSettings(store, DEFAULT_USER).callModel, "env-model", "\"\" removes the saved value");
  applySettingsUpdate(store, DEFAULT_USER, { webSearch: false });
  assert.equal(getSettings(store, DEFAULT_USER).apiKey, "sk-secret-123456", "omitted fields stay unchanged");
  applySettingsUpdate(store, DEFAULT_USER, { apiKey: "" });
  assert.equal(getSettings(store, DEFAULT_USER).apiKey, "");
  applySettingsUpdate(store, DEFAULT_USER, { provider: "ollama" });
  assert.equal(settingsView(getSettings(store, DEFAULT_USER), false).configured, true, "ollama needs no key");

  // Data survives reopening.
  store.close();
  const reopened = new Store(dir, makeCipher(loadSecrets(dir).encryptionKey));
  assert.equal(reopened.getProfile(DEFAULT_USER).name, "Alex Doe");
  reopened.close();
  console.log("check: all assertions passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
