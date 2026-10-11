// Offline end-to-end speakerphone call against a temp SQLite DB and a scripted fake OpenAI-compatible server. Run: npm run smoke
import "../src/env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CallPlanSchema, type WsEvent } from "@ai-caller/shared";
import { loadSecrets, makeCipher } from "../src/crypto.js";
import { DEFAULT_USER, Store } from "../src/db.js";
import { Hub } from "../src/events.js";
import { CallSession } from "../src/session.js";
import { applySettingsUpdate, getSettings, settingsView } from "../src/settings.js";

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
const store = new Store(dir, makeCipher(loadSecrets(dir).encryptionKey));
const events: WsEvent[] = [];
const hub = new Hub();
hub.emit = (_u, e) => void events.push(e);
const ctx = { store, hub };
try {
  applySettingsUpdate(store, DEFAULT_USER, { provider: "custom", baseUrl, apiKey: API_KEY, callModel: "fake-call", approvalTimeoutSeconds: 60 });
  store.updateProfile(DEFAULT_USER, { name: "Alex Doe" });
  store.setDetail(DEFAULT_USER, "account_number", "ACCT-99887766");
  const plan = CallPlanSchema.parse({
    company: "Acme Bank",
    phoneNumber: "+18005550100",
    issue: "Charged twice for the same order",
    desiredOutcome: "Refund the duplicate charge",
    mode: "resolve",
    autonomy: "approve_decisions",
    sharedDetailKeys: ["account_number"],
  });
  const call = store.createCall(DEFAULT_USER, plan);
  const session = CallSession.start(ctx, DEFAULT_USER, call);
  const statusNow = () => store.getCall(DEFAULT_USER, call.id)!.status;
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
  const audit = store.listAudit(call.id);
  assert.ok(audit.some((a) => a.kind === "commitment_recorded" && a.detail.approvalId === approval.id));
  assert.equal(statusNow(), "with_human");

  r = await session.heard("Done. Your reference number is R 7 7 4 2.");
  assert.deepEqual(r.actions, [{ type: "hang_up", reason: "Refund approved." }]);
  assert.match(r.say, /Goodbye/);
  await session.done;

  const done = store.getCall(DEFAULT_USER, call.id)!;
  assert.equal(done.status, "completed");
  assert.equal(done.outcome?.result, "resolved");
  assert.match(done.outcome?.summary ?? "", /refunded the double charge/);
  assert.deepEqual(done.outcome?.referenceNumbers, ["R7742"]);
  assert.equal(done.outcome?.followUps.length, 1);
  const pb = store.getPlaybook(DEFAULT_USER, "acme bank")!;
  assert.deepEqual(pb.menuPaths, ["Press 1 for billing"]);
  assert.deepEqual(pb.tactics, ["Ask for a refund of the duplicate charge directly"], "personal data is filtered from the playbook");
  assert.ok(events.some((e) => e.type === "outcome" && e.callId === call.id));
  const transcript = store.listTranscript(call.id);
  assert.ok(transcript.some((t) => t.speaker === "system" && t.text.startsWith("Pressing 1")));
  assert.ok(transcript.some((t) => t.speaker === "ai" && /AI assistant/.test(t.text)));

  // JSON helper fell back after the provider rejected response_format.
  const firstJson = requests.findIndex((q) => q.kind === "reject");
  assert.ok(firstJson >= 0 && requests[firstJson + 1] && !requests[firstJson + 1].json && requests[firstJson + 1].status === 200);

  // Stored details are never in the prompt.
  assert.ok(!JSON.stringify((session as unknown as { messages: unknown[] }).messages[0]).includes("99887766"));

  // API keys are encrypted at rest and never returned.
  const rawKey = store.getSettingsRaw(DEFAULT_USER).apiKey;
  assert.ok(rawKey && !rawKey.includes(API_KEY));
  const dbBytes = ["aicaller.db", "aicaller.db-wal"]
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f).toString("latin1"))
    .join("");
  assert.ok(!dbBytes.includes(API_KEY) && !dbBytes.includes("99887766"), "no plaintext secrets in the database files");
  const view = settingsView(getSettings(store, DEFAULT_USER), false);
  assert.ok(view.hasApiKey && !JSON.stringify(view).includes(API_KEY));

  // Enforcement: commitments without approval and unshared details are rejected and audited.
  const call2 = store.createCall(DEFAULT_USER, { ...plan, sharedDetailKeys: [] });
  const s2 = CallSession.start(ctx, DEFAULT_USER, call2);
  assert.match(String(s2.executeTool("record_commitment", { description: "Agree to a new plan" }).output.error), /Rejected/);
  assert.match(String(s2.executeTool("record_commitment", { description: "x", approval_id: approval.id }).output.error), /not approved for this call/);
  assert.match(String(s2.executeTool("record_commitment", { description: "x", rule_number: 1 }).output.error), /Rejected/);
  assert.match(String(s2.executeTool("get_account_detail", { key: "account_number" }).output.error), /Not allowed/);
  const kinds = store.listAudit(call2.id).map((a) => a.kind);
  assert.deepEqual(kinds, ["commitment_rejected", "commitment_rejected", "commitment_rejected", "detail_denied"]);
  s2.endByUser();
  await s2.done;
  assert.equal(store.getCall(DEFAULT_USER, call2.id)!.status, "canceled");

  const call3 = store.createCall(DEFAULT_USER, { ...plan, autonomy: "explain_only" });
  const s3 = CallSession.start(ctx, DEFAULT_USER, call3);
  assert.match(String(s3.executeTool("get_account_detail", { key: "account_number" }).output.error), /explain_only/);
  s3.takeOver();
  await s3.done;
  assert.equal(store.getCall(DEFAULT_USER, call3.id)!.status, "transferred");

  console.log(`smoke: all assertions passed (${requests.length} model requests)`);
} finally {
  store.close();
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
