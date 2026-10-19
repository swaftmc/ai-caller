import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { toFile } from "openai";
import { z } from "zod";
import {
  AccountDetailCreateSchema,
  ApprovalDecisionSchema,
  CallPlanSchema,
  EmailSchema,
  HeardSchema,
  InstructionSchema,
  IntakeReplySchema,
  IntakeRequestSchema,
  InviteCreateSchema,
  ProfileUpdateSchema,
  SettingsUpdateSchema,
  type AdminOverview,
} from "@ai-caller/shared";
import { RateLimiter, registerAuth, toMe, userFromRequest } from "./auth.js";
import { askJson, guardedClient, makeClient, planningModel } from "./llm.js";
import type { Mailer } from "./mail.js";
import { assertPublicUrl } from "./netguard.js";
import { intakeSystemPrompt } from "./prompt.js";
import { CallSession, MAX_LIVE_CALLS, MAX_SERVER_CALLS, getSession, sessionsFor, type AppContext } from "./session.js";
import { applySettingsUpdate, getSettings, isConfigured, settingsView, sttEnabled, ttsEnabled } from "./settings.js";
import { registerStatic } from "./web.js";

export interface AppOptions extends AppContext {
  /** The address people use, e.g. https://caller.example.com; only its Host and Origin are accepted. */
  publicUrl: string;
  adminEmail: string;
  mailer: Mailer;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function badRequest(reply: FastifyReply, err: z.ZodError | string) {
  return reply.code(400).send({ error: typeof err === "string" ? err : z.prettifyError(err) });
}

export async function buildApp(o: AppOptions): Promise<FastifyInstance> {
  const { store, hub } = o;
  const pub = new URL(o.publicUrl);
  const publicUrl = pub.origin;
  const limiter = new RateLimiter();
  const app = Fastify({
    logger: {
      level: process.env.AICALLER_LOG_LEVEL || "warn",
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
    bodyLimit: 1024 * 1024,
    // Caddy on the same machine forwards the client address.
    trustProxy: "loopback",
  });
  await app.register(websocket);
  app.addContentTypeParser(["audio/wav", "audio/x-wav", "audio/wave"], { parseAs: "buffer", bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );
  app.decorateRequest("user", null);

  // Only our own host name (DNS-rebinding guard), and writes only from our own pages (CSRF guard).
  app.addHook("onRequest", async (req, reply) => {
    if ((req.headers.host ?? "").toLowerCase() !== pub.host) return reply.code(403).send({ error: "Forbidden host" });
    if (!SAFE_METHODS.has(req.method) && req.headers.origin !== publicUrl) return reply.code(403).send({ error: "Forbidden origin" });
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
    if (pub.protocol === "https:") reply.header("Strict-Transport-Security", "max-age=31536000");
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const user = req.headers.origin === publicUrl ? userFromRequest(req, store) : null;
    if (!user) socket.close(4401, "unauthorized");
    else hub.accept(socket, user.id);
  });

  await registerAuth(app, { store, publicUrl, adminEmail: o.adminEmail, mailer: o.mailer, limiter });

  /** Drops a user's live calls (no summary), then deletes the user and everything they own. */
  const removeUser = async (id: string) => {
    for (const s of sessionsFor(id)) s.discard();
    hub.disconnect(id);
    return store.deleteUser(id);
  };

  await app.register(
    async (api) => {
      api.addHook("onRequest", async (req, reply) => {
        req.user = userFromRequest(req, store);
        if (!req.user) return reply.code(401).send({ error: "Unauthorized" });
      });
      const uid = (req: FastifyRequest) => req.user!.id;
      const limited = (req: FastifyRequest, reply: FastifyReply, what: string, max: number) => {
        if (limiter.allow(`${what}:${uid(req)}`, max, 60_000)) return false;
        void reply.code(429).send({ error: "Too many requests. Wait a minute and try again." });
        return true;
      };

      // Account
      api.get("/me", async (req) => toMe(req.user!));
      api.delete("/me", async (req, reply) => {
        await removeUser(uid(req));
        reply.header("Set-Cookie", `aic_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${pub.protocol === "https:" ? "; Secure" : ""}`);
        return { ok: true };
      });

      // Admin: invites and users
      await api.register(
        async (admin) => {
          admin.addHook("onRequest", async (req, reply) => {
            if (!req.user?.isAdmin) return reply.code(403).send({ error: "Admins only" });
          });
          admin.get("/overview", async (): Promise<AdminOverview> => ({ users: store.listUsers(), pendingInvites: store.pendingInvites() }));
          admin.post("/invites", async (req, reply) => {
            const body = InviteCreateSchema.safeParse(req.body);
            if (!body.success) return badRequest(reply, body.error);
            store.addInvite(body.data.email, uid(req));
            const text = `You have been invited to AI Caller. Sign in with this email address at:\n\n${publicUrl}/login/\n`;
            const mailed = await o.mailer(body.data.email, "You're invited to AI Caller", text).then(
              () => true,
              (err: Error) => (req.log.error(`invite email failed: ${err.message}`), false),
            );
            return { ok: true, mailed };
          });
          admin.delete<{ Params: { email: string } }>("/invites/:email", async (req, reply) => {
            const email = EmailSchema.safeParse(req.params.email);
            if (!email.success || !store.deleteInvite(email.data)) return reply.code(404).send({ error: "No such invite" });
            return { ok: true };
          });
          admin.delete<{ Params: { id: string } }>("/users/:id", async (req, reply) => {
            if (req.params.id === uid(req)) return badRequest(reply, "Use Delete my account on the Profile page to remove yourself.");
            if (!(await removeUser(req.params.id))) return reply.code(404).send({ error: "No such user" });
            return { ok: true };
          });
        },
        { prefix: "/admin" },
      );

      // Profile and stored details
      api.get("/profile", async (req) => ({ profile: store.getProfile(uid(req)), details: store.listDetails(uid(req)) }));
      api.put("/profile", async (req, reply) => {
        const body = ProfileUpdateSchema.safeParse(req.body);
        if (!body.success) return badRequest(reply, body.error);
        return { profile: store.updateProfile(uid(req), body.data), details: store.listDetails(uid(req)) };
      });
      api.post("/profile/details", async (req, reply) => {
        const body = AccountDetailCreateSchema.safeParse(req.body);
        if (!body.success) return badRequest(reply, body.error);
        store.setDetail(uid(req), body.data.key, body.data.value);
        return { details: store.listDetails(uid(req)) };
      });
      api.delete<{ Params: { key: string } }>("/profile/details/:key", async (req, reply) => {
        if (!store.deleteDetail(uid(req), req.params.key)) return reply.code(404).send({ error: "No such detail" });
        return { details: store.listDetails(uid(req)) };
      });

      // Settings
      api.get("/settings", async (req) => settingsView(getSettings(store, uid(req))));
      api.put("/settings", async (req, reply) => {
        const body = SettingsUpdateSchema.safeParse(req.body);
        if (!body.success) return badRequest(reply, body.error);
        for (const [field, label] of [
          ["baseUrl", "Base URL"],
          ["sttUrl", "Speech recognition URL"],
          ["ttsUrl", "Voice URL"],
        ] as const) {
          const url = body.data[field]?.trim();
          if (!url) continue;
          try {
            await assertPublicUrl(url);
          } catch (err) {
            return badRequest(reply, `${label}: ${(err as Error).message}`);
          }
        }
        applySettingsUpdate(store, uid(req), body.data);
        return settingsView(getSettings(store, uid(req)));
      });

      // Intake chat
      api.post("/intake", async (req, reply) => {
        const body = IntakeRequestSchema.safeParse(req.body);
        if (!body.success) return badRequest(reply, body.error);
        if (limited(req, reply, "intake", 30)) return reply;
        const s = getSettings(store, uid(req));
        if (!isConfigured(s)) return badRequest(reply, "Set up a model and API key in Settings first.");
        const canSearch = s.provider === "openrouter" && s.webSearch;
        const base = planningModel(s);
        const keys = store.detailKeys(uid(req));
        try {
          const out = await askJson({
            client: makeClient(s),
            model: canSearch && !base.endsWith(":online") ? `${base}:online` : base,
            system: intakeSystemPrompt(store.getProfile(uid(req)).name, keys, canSearch),
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
      api.get("/calls", async (req) => store.listCalls(uid(req)));
      api.post("/calls", async (req, reply) => {
        const plan = CallPlanSchema.safeParse((req.body as { plan?: unknown } | null)?.plan);
        if (!plan.success) return badRequest(reply, plan.error);
        return store.createCall(uid(req), plan.data);
      });
      api.get<{ Params: { id: string } }>("/calls/:id", async (req, reply) => {
        const call = store.getCall(uid(req), req.params.id);
        if (!call) return reply.code(404).send({ error: "No such call" });
        return { call, transcript: store.listTranscript(call.id), approvals: store.listApprovals(call.id), live: Boolean(getSession(call.id)) };
      });
      api.put<{ Params: { id: string } }>("/calls/:id/plan", async (req, reply) => {
        const call = store.getCall(uid(req), req.params.id);
        if (!call) return reply.code(404).send({ error: "No such call" });
        if (call.status !== "draft") return reply.code(409).send({ error: "Only draft calls can be edited" });
        const plan = CallPlanSchema.safeParse((req.body as { plan?: unknown } | null)?.plan);
        if (!plan.success) return badRequest(reply, plan.error);
        const keys = store.detailKeys(uid(req));
        const missing = plan.data.sharedDetailKeys.filter((k) => !keys.includes(k));
        if (missing.length) return badRequest(reply, `Unknown stored details: ${missing.join(", ")}`);
        store.updatePlan(uid(req), call.id, plan.data);
        return store.getCall(uid(req), call.id);
      });
      api.post<{ Params: { id: string } }>("/calls/:id/start", async (req, reply) => {
        const call = store.getCall(uid(req), req.params.id);
        if (!call) return reply.code(404).send({ error: "No such call" });
        if (getSession(call.id)) return call;
        if (call.status !== "draft") return reply.code(409).send({ error: `Call is ${call.status}` });
        if (!isConfigured(getSettings(store, uid(req)))) return badRequest(reply, "Set up a model and API key in Settings first.");
        if (store.countLiveCalls(uid(req)) >= MAX_LIVE_CALLS) return reply.code(429).send({ error: `At most ${MAX_LIVE_CALLS} of your calls can run at once` });
        if (store.countLiveCalls(null) >= MAX_SERVER_CALLS) return reply.code(503).send({ error: "The server is busy. Try again in a few minutes." });
        CallSession.start(o, uid(req), call);
        return store.getCall(uid(req), call.id);
      });

      const live = (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const s = getSession(req.params.id);
        if (!s || s.userId !== uid(req)) {
          void reply.code(409).send({ error: "This call is not running" });
          return null;
        }
        return s;
      };
      api.post<{ Params: { id: string } }>("/calls/:id/local/heard", async (req, reply) => {
        const body = HeardSchema.safeParse(req.body);
        if (!body.success) return badRequest(reply, body.error);
        if (limited(req, reply, "heard", 120)) return reply;
        const s = live(req, reply);
        if (!s) return reply;
        return s.heard(body.data.text);
      });
      api.post<{ Params: { id: string } }>("/calls/:id/instruct", async (req, reply) => {
        const body = InstructionSchema.safeParse(req.body);
        if (!body.success) return badRequest(reply, body.error);
        if (limited(req, reply, "instruct", 30)) return reply;
        const s = live(req, reply);
        if (!s) return reply;
        void s.instruct(body.data.text);
        return { ok: true };
      });
      api.post<{ Params: { id: string } }>("/calls/:id/takeover", async (req, reply) => {
        const s = live(req, reply);
        if (!s) return reply;
        return { actions: s.takeOver() };
      });
      api.post<{ Params: { id: string } }>("/calls/:id/end", async (req, reply) => {
        const s = live(req, reply);
        if (!s) return reply;
        return { actions: s.endByUser() };
      });
      api.post<{ Params: { id: string } }>("/approvals/:id", async (req, reply) => {
        const body = ApprovalDecisionSchema.safeParse(req.body);
        if (!body.success) return badRequest(reply, body.error);
        const approval = store.getApproval(req.params.id);
        if (!approval || !store.getCall(uid(req), approval.callId)) return reply.code(404).send({ error: "No such approval" });
        const s = getSession(approval.callId);
        const resolved = s?.decideApproval(approval.id, body.data.decision, body.data.note?.trim() || null);
        if (!resolved) return reply.code(409).send({ error: "This request is no longer pending" });
        return resolved;
      });

      api.get("/playbooks", async (req) => store.listPlaybooks(uid(req)));

      // Speech: OpenAI-compatible transcription and synthesis
      api.post("/speech/transcribe", async (req, reply) => {
        const s = getSettings(store, uid(req));
        if (!sttEnabled(s)) return badRequest(reply, "Server speech recognition is not configured.");
        if (!Buffer.isBuffer(req.body) || req.body.length < 44) return badRequest(reply, "Send a WAV file as audio/wav.");
        if (limited(req, reply, "stt", 120)) return reply;
        try {
          const res = await guardedClient(s.sttUrl, s.sttApiKey, 30_000).audio.transcriptions.create({
            file: await toFile(req.body, "utterance.wav", { type: "audio/wav" }),
            model: s.sttModel,
          });
          return { text: res.text.trim() };
        } catch (err) {
          return reply.code(502).send({ error: `Transcription failed: ${(err as Error).message}` });
        }
      });
      api.post("/speech/synthesize", async (req, reply) => {
        const s = getSettings(store, uid(req));
        if (!ttsEnabled(s)) return badRequest(reply, "Server speech synthesis is not configured.");
        const body = z.object({ text: z.string().trim().min(1).max(2000) }).safeParse(req.body);
        if (!body.success) return badRequest(reply, body.error);
        if (limited(req, reply, "tts", 120)) return reply;
        try {
          const res = await guardedClient(s.ttsUrl, s.ttsApiKey, 30_000).audio.speech.create({
            model: s.ttsModel,
            voice: s.ttsVoice,
            input: body.data.text,
            response_format: "mp3",
          });
          return reply.type("audio/mpeg").header("Cache-Control", "no-store").send(Buffer.from(await res.arrayBuffer()));
        } catch (err) {
          return reply.code(502).send({ error: `Speech synthesis failed: ${(err as Error).message}` });
        }
      });
    },
    { prefix: "/api" },
  );

  registerStatic(app);
  return app;
}
