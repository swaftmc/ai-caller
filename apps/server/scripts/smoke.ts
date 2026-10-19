// Offline end-to-end check: a scripted speakerphone call against a fake OpenAI-compatible server, then sign-in, isolation and guards over HTTP. Run: npm run smoke
import "../src/env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CallPlanSchema, type AdminOverview, type WsEvent } from "@ai-caller/shared";
import { loadEncryptionKey, makeCipher } from "../src/crypto.js";
import { Store } from "../src/db.js";
import { Hub } from "../src/events.js";
import { buildApp } from "../src/http.js";
import { CallSession } from "../src/session.js";
import { setAllowPrivateUrls } from "../src/netguard.js";
import { applySettingsUpdate } from "../src/settings.js";

type Msg = { role: string; content?: string | null; tool_calls?: { function: { name: string } }[] };
const API_KEY = "sk-smoke-secret-key-0000";
const requests: { json: boolean; status: number; kind: string }[] = [];
let rejectedFormat = false;

const reply = (content: string, tools: [string, Record<string, unknown>][] = []) => ({
  id: "fake",
  object: "chat.completion",
  created: 0,
  model: "fake",
  choices: [
    {
      index: 0,
      finish_reason: tools.length ? "tool_calls" : "stop",
      message: {
        role: "assistant",
        content,
        tool_calls: tools.length
          ? tools.map(([name, args], i) => ({ id: `call_${Date.now()}_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }))
          : undefined,
      },
    },
  ],
});

/** Scripted model: picks a reply from the system prompt and the last message. */
function respond(body: { messages: Msg[]; response_format?: unknown }): { status: number; json: unknown; kind: string } {
  const system = String(body.messages[0]?.content ?? "");
  const last = body.messages[body.messages.length - 1];
  const lastText = String(last?.content ?? "");
  if (body.response_format && !rejectedFormat) {
    rejectedFormat = true;
    return { status: 400, json: { error: { message: "response_format is not supported" } }, kind: "reject" };
  }
  if (system.startsWith("You classify")) return { status: 200, json: reply(JSON.stringify({ live_human: false, confidence: 0.9 })), kind: "classifier" };
  if (system.startsWith("You review the transcript")) {
    return {
      status: 200,
      kind: "summary",
      json: reply(
        "```json\n" +
          JSON.stringify({
            summary: "The AI reached Dana in billing, who refunded the double charge.",
            referenceNumbers: ["R7742"],
            followUps: ["Check the refund on your statement in 5 business days."],
            playbook: {
              menuPaths: ["Press 1 for billing"],
              tactics: ["Ask for a refund of the duplicate charge directly", "Account ACCT-99887766 was refunded", "Reference R7742"],
            },
          }) +
          "\n```",
      ),
    };
  }
  // Call turns.
  if (last.role === "tool") {
    const prevAssistant = [...body.messages].reverse().find((m) => m.role === "assistant");
    const tool = prevAssistant?.tool_calls?.[0]?.function.name;
    if (tool === "request_approval") return { status: 200, json: reply("", [["wait", {}]]), kind: "call" };
    if (tool === "record_commitment") return { status: 200, json: reply("Great, please go ahead with the refund."), kind: "call" };
    if (tool === "note_info") return { status: 200, json: reply("Thank you, Dana. Goodbye.", [["end_call", { result: "resolved", summary: "Refund approved." }]]), kind: "call" };
    if (tool === "mark_human_reached") return { status: 200, json: reply(""), kind: "call" };
  }
  if (lastText.includes("press 1")) return { status: 200, json: reply("", [["send_dtmf", { digits: "1" }]]), kind: "call" };
  if (lastText.includes("Please hold")) return { status: 200, json: reply("", [["enter_hold_mode", { reason: "transferring to billing" }]]), kind: "call" };
  if (lastText.startsWith("[System] A live person")) {
    return {
      status: 200,
      kind: "call",
      json: reply("Hi, I'm an AI assistant calling on behalf of Alex Doe. I'm calling about a double charge on the account.", [["mark_human_reached", {}]]),
    };
  }
  if (lastText.includes("refund")) {
    return {
      status: 200,
      kind: "call",
      json: reply("Let me check with the account holder.", [["request_approval", { question: "Accept a $20 refund to the card?", options: ["Accept", "Decline"] }]]),
    };
  }
  const approved = lastText.match(/APPROVED request (\w+)/);
  if (approved) return { status: 200, kind: "call", json: reply("", [["record_commitment", { description: "Accept $20 refund", approval_id: approved[1] }]]) };
  if (lastText.includes("reference number")) return { status: 200, kind: "call", json: reply("", [["note_info", { info: "Reference number R7742" }]]) };
  return { status: 200, json: reply("", [["wait", {}]]), kind: "call" };
}

const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    assert.equal(req.headers.authorization, `Bearer ${API_KEY}`);
    const body = JSON.parse(raw);
    const r = respond(body);
    requests.push({ json: Boolean(body.response_format), status: r.status, kind: r.kind });
    res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json));
  });
});
await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
const baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicaller-smoke-"));
const store = new Store(dir, makeCipher(loadEncryptionKey(dir, {})));
const events: WsEvent[] = [];
const hub = new Hub();
hub.emit = (_u, e) => void events.push(e);
const ctx = { store, hub };
const countRows = (userId: string) =>
  ["calls", "approvals", "transcript_entries", "account_details", "settings", "sessions", "audit_events", "playbooks"].reduce(
    (n, t) => n + Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(userId)?.n),
    0,
  );
try {
  // ---- Part 1: a whole scripted speakerphone call ----
  // The fake model listens on 127.0.0.1, which the URL guard blocks; part 2 checks the guard with this switched off again.
  setAllowPrivateUrls(true);
  const uid = store.createUser("alex@example.com", false).id;
  applySettingsUpdate(store, uid, { provider: "custom", baseUrl, apiKey: API_KEY, callModel: "fake-call", approvalTimeoutSeconds: 60 });
  store.updateProfile(uid, { name: "Alex Doe" });
  store.setDetail(uid, "account_number", "ACCT-99887766");
  const plan = CallPlanSchema.parse({
    company: "Acme Bank",
    phoneNumber: "+18005550100",
    issue: "Charged twice for the same order",
    desiredOutcome: "Refund the duplicate charge",
    mode: "resolve",
    autonomy: "approve_decisions",
    sharedDetailKeys: ["account_number"],
  });
  const call = store.createCall(uid, plan);
  const session = CallSession.start(ctx, uid, call);
  const statusNow = () => store.getCall(uid, call.id)!.status;
  assert.equal(statusNow(), "dialing");

  let r = await session.heard("Welcome to Acme Bank. For billing, press 1.");
  assert.deepEqual(r.actions, [{ type: "press_keys", digits: "1" }]);
  assert.equal(statusNow(), "navigating");

  r = await session.heard("Please hold while we connect you.");
  assert.deepEqual(r.actions, [{ type: "hold", on: true }]);
  assert.equal(statusNow(), "on_hold");

  const callsBefore = requests.filter((q) => q.kind === "call").length;
  r = await session.heard("Your call is important to us. Please continue to hold.");
  assert.deepEqual(r, { say: "", actions: [] }, "recorded message is ignored");
  r = await session.heard("Your call is important to us. Please continue to hold.");
  assert.deepEqual(r, { say: "", actions: [] }, "repeated message is ignored");
  r = await session.heard("Here at Acme we value every customer.");
  assert.deepEqual(r, { say: "", actions: [] }, "classifier says recording");
  assert.equal(requests.filter((q) => q.kind === "call").length, callsBefore, "the call model is not used on hold");
  assert.equal(requests.filter((q) => q.kind === "classifier").length, 1);
  assert.equal(statusNow(), "on_hold");

  r = await session.heard("Hi, my name is Dana, how can I help?");
  assert.deepEqual(r.actions[0], { type: "hold", on: false });
  assert.match(r.say, /AI assistant calling on behalf of Alex Doe/);
  assert.equal(statusNow(), "with_human");

  r = await session.heard("I can offer a refund of 20 dollars to your card.");
  assert.match(r.say, /check with the account holder/);
  assert.equal(statusNow(), "awaiting_approval");
  const approval = store.listApprovals(call.id)[0];
  assert.equal(approval.status, "pending");
  assert.ok(events.some((e) => e.type === "approval" && e.approval.id === approval.id));

  const outputsBefore = events.filter((e) => e.type === "local_output").length;
  assert.equal(session.decideApproval(approval.id, "approve", "Yes, take it")?.status, "approved");
  assert.equal(session.decideApproval(approval.id, "deny", null), null, "cannot decide twice");
  for (let i = 0; i < 100 && events.filter((e) => e.type === "local_output").length === outputsBefore; i++) await new Promise((ok) => setTimeout(ok, 50));
  const outputs = events.filter((e) => e.type === "local_output");
  assert.equal(outputs.length, outputsBefore + 1, "approval turn is pushed as local_output");
  assert.match((outputs.at(-1) as Extract<WsEvent, { type: "local_output" }>).say, /go ahead with the refund/);
  assert.ok(store.listAudit(call.id).some((a) => a.kind === "commitment_recorded" && a.detail.approvalId === approval.id));
  assert.equal(statusNow(), "with_human");

  r = await session.heard("Done. Your reference number is R 7 7 4 2.");
  assert.deepEqual(r.actions, [{ type: "hang_up", reason: "Refund approved." }]);
  assert.match(r.say, /Goodbye/);
  await session.done;

  const done = store.getCall(uid, call.id)!;
  assert.equal(done.status, "completed");
  assert.equal(done.outcome?.result, "resolved");
  assert.match(done.outcome?.summary ?? "", /refunded the double charge/);
  assert.deepEqual(done.outcome?.referenceNumbers, ["R7742"]);
  assert.equal(done.outcome?.followUps.length, 1);
  const pb = store.getPlaybook(uid, "acme bank")!;
  assert.deepEqual(pb.menuPaths, ["Press 1 for billing"]);
  assert.deepEqual(pb.tactics, ["Ask for a refund of the duplicate charge directly"], "personal data is filtered from the playbook");
  assert.ok(events.some((e) => e.type === "outcome" && e.callId === call.id));
  const transcript = store.listTranscript(call.id);
  assert.ok(transcript.some((t) => t.speaker === "system" && t.text.startsWith("Pressing 1")));
  assert.ok(transcript.some((t) => t.speaker === "ai" && /AI assistant/.test(t.text)));

  // JSON helper fell back after the provider rejected response_format.
  const firstJson = requests.findIndex((q) => q.kind === "reject");
  assert.ok(firstJson >= 0 && requests[firstJson + 1] && !requests[firstJson + 1].json && requests[firstJson + 1].status === 200);

  // Stored details are never in the prompt; keys and details are encrypted at rest.
  assert.ok(!JSON.stringify((session as unknown as { messages: unknown[] }).messages[0]).includes("99887766"));
  assert.ok(!store.getSettingsRaw(uid).apiKey.includes(API_KEY));
  const dbBytes = ["aicaller.db", "aicaller.db-wal"]
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f).toString("latin1"))
    .join("");
  assert.ok(!dbBytes.includes(API_KEY) && !dbBytes.includes("99887766"), "no plaintext secrets in the database files");

  // Enforcement: commitments without approval and unshared details are rejected and audited.
  const call2 = store.createCall(uid, { ...plan, sharedDetailKeys: [] });
  const s2 = CallSession.start(ctx, uid, call2);
  assert.match(String(s2.executeTool("record_commitment", { description: "Agree to a new plan" }).output.error), /Rejected/);
  assert.match(String(s2.executeTool("record_commitment", { description: "x", approval_id: approval.id }).output.error), /not approved for this call/);
  assert.match(String(s2.executeTool("record_commitment", { description: "x", rule_number: 1 }).output.error), /Rejected/);
  assert.match(String(s2.executeTool("get_account_detail", { key: "account_number" }).output.error), /Not allowed/);
  assert.deepEqual(
    store.listAudit(call2.id).map((a) => a.kind),
    ["commitment_rejected", "commitment_rejected", "commitment_rejected", "detail_denied"],
  );
  s2.endByUser();
  await s2.done;
  assert.equal(store.getCall(uid, call2.id)!.status, "canceled");

  const call3 = store.createCall(uid, { ...plan, autonomy: "explain_only" });
  const s3 = CallSession.start(ctx, uid, call3);
  assert.match(String(s3.executeTool("get_account_detail", { key: "account_number" }).output.error), /explain_only/);
  s3.takeOver();
  await s3.done;
  assert.equal(store.getCall(uid, call3.id)!.status, "transferred");

  // ---- Part 2: the hosted web app over HTTP ----
  setAllowPrivateUrls(false);
  const PUB = "https://aicaller.test";
  const mail: { to: string; text: string }[] = [];
  const liveHub = new Hub();
  const app = await buildApp({ store, hub: liveHub, publicUrl: PUB, adminEmail: "admin@example.com", mailer: async (to, _s, text) => void mail.push({ to, text }) });
  await app.ready();
  let res: Awaited<ReturnType<typeof app.inject>>;
  const H = { host: "aicaller.test", origin: PUB };
  type Method = "GET" | "POST" | "PUT" | "DELETE";
  const call_ = (method: Method, url: string, o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.inject({ method, url, headers: { ...H, ...(o.cookie ? { cookie: `aic_session=${o.cookie}` } : {}), ...o.headers }, payload: o.body as object });
  const signIn = async (email: string) => {
    const before = mail.length;
    assert.equal((await call_("POST", "/api/auth/request", { body: { email } })).statusCode, 200);
    assert.equal(mail.length, before + 1, `${email} gets a sign-in email`);
    const token = mail.at(-1)!.text.match(/\/login\/verify\/#t=([A-Za-z0-9_-]+)/)![1];
    const v = await call_("POST", "/api/auth/verify", { body: { token } });
    assert.equal(v.statusCode, 200);
    const setCookie = String(v.headers["set-cookie"]);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/);
    return { cookie: setCookie.match(/aic_session=([^;]+)/)![1], token, id: (v.json() as { id: string }).id };
  };

  // Sign-in: no email for uninvited addresses (same answer), the admin and invitees get a single-use link.
  res = await call_("POST", "/api/auth/request", { body: { email: "stranger@example.com" } });
  assert.equal(res.statusCode, 200);
  assert.equal(mail.length, 0, "uninvited addresses get no email");
  const admin = await signIn("admin@example.com");
  assert.equal((await call_("POST", "/api/auth/verify", { body: { token: admin.token } })).statusCode, 400, "a sign-in link works once");
  assert.equal((await call_("GET", "/api/me", { cookie: admin.cookie })).json().isAdmin, true);
  assert.equal((await call_("GET", "/api/me")).statusCode, 401);
  assert.equal((await call_("GET", "/api/me", { cookie: "forged" })).statusCode, 401);

  res = await call_("POST", "/api/admin/invites", { cookie: admin.cookie, body: { email: "Sam@Example.com" } });
  assert.equal(res.statusCode, 200);
  assert.equal(mail.at(-1)!.to, "sam@example.com", "invite email sent, address normalized");
  const sam = await signIn("sam@example.com");
  assert.equal((await call_("GET", "/api/me", { cookie: sam.cookie })).json().isAdmin, false);
  assert.equal((await call_("GET", "/api/admin/overview", { cookie: sam.cookie })).statusCode, 403, "only the admin can use the admin API");
  const overview = (await call_("GET", "/api/admin/overview", { cookie: admin.cookie })).json() as AdminOverview;
  assert.deepEqual(overview.users.map((u) => u.email).sort(), ["admin@example.com", "alex@example.com", "sam@example.com"]);

  // Request guards: Host, Origin (CSRF), security headers.
  assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { host: "evil.test", cookie: `aic_session=${sam.cookie}` } })).statusCode, 403);
  assert.equal((await call_("PUT", "/api/profile", { cookie: sam.cookie, body: { name: "x" }, headers: { origin: "https://evil.test" } })).statusCode, 403);
  assert.equal(
    (await app.inject({ method: "PUT", url: "/api/profile", headers: { host: "aicaller.test", cookie: `aic_session=${sam.cookie}` }, payload: { name: "x" } })).statusCode,
    403,
    "writes without an Origin header are refused",
  );
  res = await call_("GET", "/api/me", { cookie: sam.cookie });
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.match(String(res.headers["strict-transport-security"]), /max-age/);

  // Settings: provider URLs must be public https.
  res = await call_("PUT", "/api/settings", { cookie: sam.cookie, body: { provider: "custom", baseUrl: "https://127.0.0.1:8080/v1" } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /private/);
  res = await call_("PUT", "/api/settings", { cookie: sam.cookie, body: { sttUrl: "http://api.openai.com/v1" } });
  assert.match(res.json().error, /https/);
  res = await call_("PUT", "/api/settings", { cookie: sam.cookie, body: { baseUrl: "https://169.254.169.254/latest" } });
  assert.match(res.json().error, /private/, "cloud metadata address refused");
  assert.equal((await call_("GET", "/api/settings", { cookie: sam.cookie })).json().baseUrl, "", "refused settings are not saved");

  // Isolation: Sam sees and controls nothing of Alex's.
  const live = store.createCall(uid, plan);
  const s4 = CallSession.start(ctx, uid, live);
  assert.deepEqual((await call_("GET", "/api/calls", { cookie: sam.cookie })).json(), []);
  assert.equal((await call_("GET", `/api/calls/${call.id}`, { cookie: sam.cookie })).statusCode, 404);
  assert.equal((await call_("PUT", `/api/calls/${live.id}/plan`, { cookie: sam.cookie, body: { plan } })).statusCode, 404);
  assert.equal((await call_("POST", `/api/approvals/${approval.id}`, { cookie: sam.cookie, body: { decision: "approve" } })).statusCode, 404);
  assert.equal((await call_("POST", `/api/calls/${live.id}/local/heard`, { cookie: sam.cookie, body: { text: "hello" } })).statusCode, 409);
  assert.equal((await call_("POST", `/api/calls/${live.id}/end`, { cookie: sam.cookie, body: {} })).statusCode, 409);
  assert.equal(s4.ended, false, "Alex's call still runs");
  assert.deepEqual((await call_("GET", "/api/profile", { cookie: sam.cookie })).json().details, []);
  assert.deepEqual((await call_("GET", "/api/playbooks", { cookie: sam.cookie })).json(), []);
  assert.equal((await call_("GET", "/api/settings", { cookie: sam.cookie })).json().hasApiKey, false, "Alex's key is not Sam's");
  s4.endByUser();
  await s4.done;

  // WebSocket: cookie and Origin checked on upgrade; each socket gets only its own user's events.
  const openWs = (headers: Record<string, string>) => {
    const got: string[] = [];
    let closeCode = 0;
    const closed = new Promise<void>((ok) => {
      void app
        .injectWS("/ws", { headers }, {
          onInit: (ws) => {
            ws.on("message", (d) => got.push(String(d)));
            ws.on("close", (code) => {
              closeCode = code;
              ok();
            });
          },
        })
        .catch(() => ok());
    });
    return { got, closed, code: () => closeCode };
  };
  const samWs = openWs({ ...H, cookie: `aic_session=${sam.cookie}` });
  const adminWs = openWs({ ...H, cookie: `aic_session=${admin.cookie}` });
  const noCookie = openWs(H);
  const badOrigin = openWs({ host: H.host, origin: "https://evil.test", cookie: `aic_session=${sam.cookie}` });
  await Promise.all([noCookie.closed, badOrigin.closed]);
  assert.equal(noCookie.code(), 4401);
  assert.equal(badOrigin.code(), 4401);
  for (let i = 0; i < 100 && (!samWs.got.length || !adminWs.got.length); i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(samWs.got[0]?.includes("ready") && adminWs.got[0]?.includes("ready"));
  applySettingsUpdate(store, sam.id, { provider: "custom", baseUrl, apiKey: API_KEY, callModel: "fake-call" });
  const samCall = (await call_("POST", "/api/calls", { cookie: sam.cookie, body: { plan } })).json() as { id: string };
  assert.equal((await call_("POST", `/api/calls/${samCall.id}/start`, { cookie: sam.cookie, body: {} })).statusCode, 200);
  for (let i = 0; i < 100 && samWs.got.length < 2; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(samWs.got.some((m) => m.includes(samCall.id)), "Sam gets events for Sam's call");
  assert.ok(!adminWs.got.some((m) => m.includes(samCall.id)), "nobody else does");
  assert.equal((await call_("GET", `/api/calls/${samCall.id}`, { cookie: admin.cookie })).statusCode, 404, "not even the admin");

  // Delete my account: the live call is dropped, every row goes, the session and invite stop working.
  assert.equal((await call_("DELETE", "/api/me", { cookie: sam.cookie })).statusCode, 200);
  await samWs.closed;
  assert.equal(countRows(sam.id), 0, "all of Sam's rows are deleted");
  assert.equal((await call_("GET", "/api/me", { cookie: sam.cookie })).statusCode, 401);
  const mailBefore = mail.length;
  await call_("POST", "/api/auth/request", { body: { email: "sam@example.com" } });
  assert.equal(mail.length, mailBefore, "a deleted account's invite is gone");

  // The admin removes a user; the admin cannot remove themselves there.
  await call_("POST", "/api/admin/invites", { cookie: admin.cookie, body: { email: "pat@example.com" } });
  const pat = await signIn("pat@example.com");
  assert.equal((await call_("DELETE", `/api/admin/users/${pat.id}`, { cookie: admin.cookie })).statusCode, 200);
  assert.equal((await call_("GET", "/api/me", { cookie: pat.cookie })).statusCode, 401);
  assert.equal((await call_("DELETE", `/api/admin/users/${admin.id}`, { cookie: admin.cookie })).statusCode, 400);

  // Rate limit: the sixth link request for one address in an hour is refused.
  for (let i = 0; i < 4; i++) await call_("POST", "/api/auth/request", { body: { email: "admin@example.com" } });
  assert.equal((await call_("POST", "/api/auth/request", { body: { email: "admin@example.com" } })).statusCode, 429);

  // Sign out ends the session.
  assert.equal((await call_("POST", "/api/auth/logout", { cookie: admin.cookie, body: {} })).statusCode, 200);
  assert.equal((await call_("GET", "/api/me", { cookie: admin.cookie })).statusCode, 401);
  adminWs.closed.catch(() => undefined);
  await app.close();

  console.log(`smoke: all assertions passed (${requests.length} model requests)`);
} finally {
  store.close();
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
