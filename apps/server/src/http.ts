import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import OpenAI, { toFile } from "openai";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  AccountDetailCreateSchema,
  ApprovalDecisionSchema,
  CallPlanSchema,
  HeardSchema,
  InstructionSchema,
  IntakeReplySchema,
  IntakeRequestSchema,
  ProfileUpdateSchema,
  SettingsUpdateSchema,
  type CallRecord,
} from "@ai-caller/shared";
import { safeEqual, type Secrets } from "./crypto.js";
import { DEFAULT_USER } from "./db.js";
import { isPackaged } from "./env.js";
import { askJson, makeClient, planningModel } from "./llm.js";
import { intakeSystemPrompt } from "./prompt.js";
import { CallSession, MAX_LIVE_CALLS, getSession, type AppContext } from "./session.js";
import { applySettingsUpdate, getSettings, isConfigured, settingsView, sttEnabled, ttsEnabled } from "./settings.js";

import { registerStatic } from "./web.js";

export interface AppOptions extends AppContext {
  secrets: Secrets;
  host: string;
  /** Optional Twilio channel: registers its routes and returns the extra Host headers to allow, or null when disabled. */
  extraChannel?: (app: FastifyInstance) => Promise<ExtraChannel | null>;
}
export interface ExtraChannel {
  allowHosts: string[];
  start(call: CallRecord): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const uid = DEFAULT_USER;

function badRequest(reply: FastifyReply, err: z.ZodError | string) {
  return reply.code(400).send({ error: typeof err === "string" ? err : z.prettifyError(err) });
}

export async function buildApp(o: AppOptions): Promise<FastifyInstance> {
  const { store, hub } = o;
  const app = Fastify({
    logger: {
      level: process.env.AICALLER_LOG_LEVEL || (isPackaged() ? "warn" : "info"),
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  if (!isPackaged()) await app.register(cors, { origin: ["http://localhost:3000", "http://127.0.0.1:3000"] });
  await app.register(formbody);
  await app.register(websocket);
  app.addContentTypeParser(["audio/wav", "audio/x-wav", "audio/wave"], { parseAs: "buffer", bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  const channel = o.extraChannel ? await o.extraChannel(app) : null;

  // DNS-rebinding guard: on loopback only our own host names are accepted.
  const loopback = LOOPBACK.has(o.host);
  app.addHook("onRequest", async (req, reply) => {
    if (!loopback) return;
    const port = (app.server.address() as AddressInfo | null)?.port;
    const host = (req.headers.host ?? "").toLowerCase();
    const ok = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(channel?.allowHosts ?? [])].includes(host);
    if (!ok) return reply.code(403).send({ error: "Forbidden host" });
  });

  app.get("/ws", { websocket: true }, (socket) => hub.accept(socket, o.secrets.dashboardToken, uid));

  await app.register(async (api) => {
    api.addHook("onRequest", async (req, reply) => {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token || !safeEqual(token, o.secrets.dashboardToken)) return reply.code(401).send({ error: "Unauthorized" });
    });

    // Profile and stored details
    api.get("/profile", async () => ({ profile: store.getProfile(uid), details: store.listDetails(uid) }));
    api.put("/profile", async (req, reply) => {
      const body = ProfileUpdateSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      return { profile: store.updateProfile(uid, body.data), details: store.listDetails(uid) };
    });
    api.post("/profile/details", async (req, reply) => {
      const body = AccountDetailCreateSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      store.setDetail(uid, body.data.key, body.data.value);
      return { details: store.listDetails(uid) };
    });
    api.delete<{ Params: { key: string } }>("/profile/details/:key", async (req, reply) => {
      if (!store.deleteDetail(uid, req.params.key)) return reply.code(404).send({ error: "No such detail" });
      return { details: store.listDetails(uid) };
    });

    // Settings
    const view = () => settingsView(getSettings(store, uid), Boolean(channel));
    api.get("/settings", async () => view());
    api.put("/settings", async (req, reply) => {
      const body = SettingsUpdateSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      applySettingsUpdate(store, uid, body.data);
      return view();
    });

    // Intake chat
    api.post("/intake", async (req, reply) => {
      const body = IntakeRequestSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      const s = getSettings(store, uid);
      if (!isConfigured(s)) return badRequest(reply, "Set up a model and API key in Settings first.");
      const canSearch = s.provider === "openrouter" && s.webSearch;
      const base = planningModel(s);
      const keys = store.detailKeys(uid);
      try {
        const out = await askJson({
          client: makeClient(s),
          model: canSearch && !base.endsWith(":online") ? `${base}:online` : base,
          system: intakeSystemPrompt(store.getProfile(uid).name, keys, canSearch),
          messages: body.data.messages,
          schema: IntakeReplySchema,
        });
        if (out.plan) out.plan.sharedDetailKeys = out.plan.sharedDetailKeys.filter((k) => keys.includes(k));
        return out;
      } catch (err) {
        return reply.code(502).send({ error: `Model request failed: ${(err as Error).message}` });
      }
    });

    // Calls
    api.get("/calls", async () => store.listCalls(uid));
    api.post("/calls", async (req, reply) => {
      const plan = CallPlanSchema.safeParse((req.body as { plan?: unknown } | null)?.plan);
      if (!plan.success) return badRequest(reply, plan.error);
      return store.createCall(uid, plan.data);
    });
    api.get<{ Params: { id: string } }>("/calls/:id", async (req, reply) => {
      const call = store.getCall(uid, req.params.id);
      if (!call) return reply.code(404).send({ error: "No such call" });
      return { call, transcript: store.listTranscript(call.id), approvals: store.listApprovals(call.id), live: Boolean(getSession(call.id)) };
    });
    api.put<{ Params: { id: string } }>("/calls/:id/plan", async (req, reply) => {
      const call = store.getCall(uid, req.params.id);
      if (!call) return reply.code(404).send({ error: "No such call" });
      if (call.status !== "draft") return reply.code(409).send({ error: "Only draft calls can be edited" });
      const plan = CallPlanSchema.safeParse((req.body as { plan?: unknown } | null)?.plan);
      if (!plan.success) return badRequest(reply, plan.error);
      const keys = store.detailKeys(uid);
      const missing = plan.data.sharedDetailKeys.filter((k) => !keys.includes(k));
      if (missing.length) return badRequest(reply, `Unknown stored details: ${missing.join(", ")}`);
      store.updatePlan(uid, call.id, plan.data);
      return store.getCall(uid, call.id);
    });
    api.post<{ Params: { id: string } }>("/calls/:id/start", async (req, reply) => {
      const call = store.getCall(uid, req.params.id);
      if (!call) return reply.code(404).send({ error: "No such call" });
      if (getSession(call.id)) return call;
      if (call.status !== "draft") return reply.code(409).send({ error: `Call is ${call.status}` });
      if (!isConfigured(getSettings(store, uid))) return badRequest(reply, "Set up a model and API key in Settings first.");
      if (store.countLiveCalls(uid) >= MAX_LIVE_CALLS) return reply.code(429).send({ error: `At most ${MAX_LIVE_CALLS} calls can run at once` });
      if (call.plan.channel === "twilio") {
        if (!channel) return badRequest(reply, "Twilio mode is not configured on this server.");
        try {
          await channel.start(call);
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      } else {
        CallSession.start(o, uid, call);
      }
      return store.getCall(uid, call.id);
    });

    const live = (id: string, reply: FastifyReply) => {
      const s = getSession(id);
      if (!s || s.userId !== uid) {
        void reply.code(409).send({ error: "This call is not running" });
        return null;
      }
      return s;
    };
    api.post<{ Params: { id: string } }>("/calls/:id/local/heard", async (req, reply) => {
      const body = HeardSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      const s = live(req.params.id, reply);
      if (!s) return reply;
      if (s.plan.channel !== "speakerphone") return badRequest(reply, "Not a speakerphone call");
      return s.heard(body.data.text);
    });
    api.post<{ Params: { id: string } }>("/calls/:id/instruct", async (req, reply) => {
      const body = InstructionSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      const s = live(req.params.id, reply);
      if (!s) return reply;
      void s.instruct(body.data.text);
      return { ok: true };
    });
    api.post<{ Params: { id: string } }>("/calls/:id/takeover", async (req, reply) => {
      const s = live(req.params.id, reply);
      if (!s) return reply;
      return { actions: s.takeOver() };
    });
    api.post<{ Params: { id: string } }>("/calls/:id/end", async (req, reply) => {
      const s = live(req.params.id, reply);
      if (!s) return reply;
      return { actions: s.endByUser() };
    });
    api.post<{ Params: { id: string } }>("/approvals/:id", async (req, reply) => {
      const body = ApprovalDecisionSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      const approval = store.getApproval(req.params.id);
      if (!approval || !store.getCall(uid, approval.callId)) return reply.code(404).send({ error: "No such approval" });
      const s = getSession(approval.callId);
      const resolved = s?.decideApproval(approval.id, body.data.decision, body.data.note?.trim() || null);
      if (!resolved) return reply.code(409).send({ error: "This request is no longer pending" });
      return resolved;
    });

    api.get("/playbooks", async () => store.listPlaybooks(uid));

    // Speech: OpenAI-compatible transcription and synthesis
    api.post("/speech/transcribe", async (req, reply) => {
      const s = getSettings(store, uid);
      if (!sttEnabled(s)) return badRequest(reply, "Server speech recognition is not configured.");
      if (!Buffer.isBuffer(req.body) || req.body.length < 44) return badRequest(reply, "Send a WAV file as audio/wav.");
      try {
        const client = new OpenAI({ apiKey: s.sttApiKey || "not-needed", baseURL: s.sttUrl, maxRetries: 1, timeout: 30_000 });
        const res = await client.audio.transcriptions.create({ file: await toFile(req.body, "utterance.wav", { type: "audio/wav" }), model: s.sttModel });
        return { text: res.text.trim() };
      } catch (err) {
        return reply.code(502).send({ error: `Transcription failed: ${(err as Error).message}` });
      }
    });
    api.post("/speech/synthesize", async (req, reply) => {
      const s = getSettings(store, uid);
      if (!ttsEnabled(s)) return badRequest(reply, "Server speech synthesis is not configured.");
      const body = z.object({ text: z.string().trim().min(1).max(2000) }).safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      try {
        const client = new OpenAI({ apiKey: s.ttsApiKey || "not-needed", baseURL: s.ttsUrl, maxRetries: 1, timeout: 30_000 });
        const res = await client.audio.speech.create({ model: s.ttsModel, voice: s.ttsVoice, input: body.data.text, response_format: "mp3" });
        return reply.type("audio/mpeg").header("Cache-Control", "no-store").send(Buffer.from(await res.arrayBuffer()));
      } catch (err) {
        return reply.code(502).send({ error: `Speech synthesis failed: ${(err as Error).message}` });
      }
    });
  }, { prefix: "/api" });

  registerStatic(app);
  return app;
}
