import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket from "ws";
import type { BrowserAction, CallRecord, CallResult, CallStatus, TurnResponse } from "@ai-caller/shared";
import { safeEqual } from "../crypto.js";
import { DEFAULT_USER } from "../db.js";
import type { ExtraChannel } from "../http.js";
import { callSystemPrompt, toolsFor } from "../prompt.js";
import { CallSession, getSession, type AppContext } from "../session.js";
import { dialableError } from "./dialable.js";
import { RT } from "./realtimeEvents.js";
import { conferenceTwiml, streamTwiml, twilioApi, twilioConfig, validTwilioRequest, type TwilioConfig } from "./twilio.js";

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const REALTIME_VOICE = "marin";
const TERMINAL_TOOLS = new Set(["wait", "send_dtmf", "enter_hold_mode", "transfer_to_user", "end_call"]);
const DEFERRED = new Set<BrowserAction["type"]>(["press_keys", "hand_off", "hang_up"]);

/** A call placed by the server: Twilio media stream <-> OpenAI Realtime, with Deepgram + HumanDetector while on hold. */
class TwilioCallSession extends CallSession {
  readonly mediaToken = randomBytes(24).toString("hex");
  callSid = "";
  private rt?: WebSocket;
  private dg?: WebSocket;
  private media?: WebSocket;
  private streamSid = "";
  private needResponse = false;
  private responding = false;
  private deferred: BrowserAction[] = [];
  private marks = new Map<string, { run: () => void; timer: NodeJS.Timeout }>();
  private dgText: string[] = [];

  constructor(
    ctx: AppContext,
    call: CallRecord,
    private cfg: TwilioConfig,
  ) {
    super(ctx, DEFAULT_USER, call);
  }

  async begin() {
    this.setStatus("dialing");
    this.log("system", `Placing the call to ${this.plan.phoneNumber} through Twilio.`);
    await this.connectRealtime();
    const res = await twilioApi(this.cfg, "/Calls.json", {
      To: this.plan.phoneNumber,
      From: this.cfg.fromNumber,
      Url: `${this.cfg.publicUrl}/twilio/voice?callId=${this.callId}`,
      StatusCallback: `${this.cfg.publicUrl}/twilio/status?callId=${this.callId}`,
    });
    this.callSid = String(res.sid ?? "");
  }

  // ---- OpenAI Realtime ----

  private send(ws: WebSocket | undefined, msg: object) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private connectRealtime(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
        headers: { Authorization: `Bearer ${this.cfg.openaiKey}` },
      });
      this.rt = ws;
      ws.once("open", () => {
        const profile = this.ctx.store.getProfile(this.userId);
        this.send(ws, {
          type: RT.sessionUpdate,
          session: {
            type: "realtime",
            instructions: callSystemPrompt({
              plan: this.plan,
              holderName: profile.name,
              playbook: this.ctx.store.getPlaybook(this.userId, this.plan.company),
              channel: "twilio",
            }),
            output_modalities: ["audio"],
            audio: {
              input: { format: { type: "audio/pcmu" }, turn_detection: { type: "server_vad" }, transcription: { model: "gpt-4o-mini-transcribe" } },
              output: { format: { type: "audio/pcmu" }, voice: REALTIME_VOICE },
            },
            tools: toolsFor(this.plan.autonomy).map((t) => ({ type: "function", ...t.function })),
            tool_choice: "auto",
          },
        });
        resolve();
      });
      ws.once("error", (err) => reject(new Error(`Realtime connection failed: ${err.message}`)));
      ws.on("message", (data) => this.onRealtime(String(data)));
      ws.on("close", () => {
        if (!this.ended) this.fail("The connection to the realtime model closed.");
      });
    });
  }

  private onRealtime(raw: string) {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    switch (ev.type) {
      case RT.audioDelta:
        if (this.media && this.streamSid) this.media.send(JSON.stringify({ event: "media", streamSid: this.streamSid, media: { payload: ev.delta } }));
        break;
      case RT.speechStarted:
        if (this.media && this.streamSid) this.media.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
        break;
      case RT.inputTranscriptDone:
        if (ev.transcript?.trim()) {
          this.log("them", ev.transcript.trim());
          if (this.status === "dialing") this.setStatus("navigating");
        }
        break;
      case RT.audioTranscriptDone:
        if (ev.transcript?.trim()) this.log("ai", ev.transcript.trim());
        break;
      case RT.functionArgsDone: {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(ev.arguments || "{}");
        } catch {
          // validation errors come back from executeTool
        }
        const out = this.executeTool(ev.name, args);
        this.send(this.rt, { type: RT.itemCreate, item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(out.output) } });
        if (out.action) {
          if (DEFERRED.has(out.action.type)) this.deferred.push(out.action);
          else void this.perform(out.action);
        }
        if (!TERMINAL_TOOLS.has(ev.name)) this.needResponse = true;
        break;
      }
      case RT.responseCreated:
        this.responding = true;
        break;
      case RT.responseDone: {
        this.responding = false;
        const actions = this.deferred.splice(0);
        // Spoken audio may still be buffered at Twilio: run keypad/hand-off/hang-up after it has played.
        if (actions.length) this.afterPlayback(() => actions.forEach((a) => void this.perform(a)));
        if (this.needResponse && !this.ended && !this.onHold) this.send(this.rt, { type: RT.responseCreate });
        this.needResponse = false;
        if (this.ended) this.closeRealtime();
        break;
      }
      case RT.error:
        console.error(`[call ${this.callId}] realtime error:`, ev.error?.message ?? raw);
        break;
    }
  }

  private inject(text: string) {
    if (this.ended) return;
    this.send(this.rt, { type: RT.itemCreate, item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.send(this.rt, { type: RT.responseCreate });
  }

  // ---- Twilio media stream ----

  attachStream(ws: WebSocket, streamSid: string) {
    this.media = ws;
    this.streamSid = streamSid;
    ws.on("message", (data) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.event === "media" && msg.media?.payload) {
        if (this.onHold) this.dg?.readyState === WebSocket.OPEN && this.dg.send(Buffer.from(msg.media.payload, "base64"));
        else this.send(this.rt, { type: RT.inputAudioAppend, audio: msg.media.payload });
      } else if (msg.event === "mark") {
        const m = this.marks.get(msg.mark?.name);
        if (m) {
          clearTimeout(m.timer);
          this.marks.delete(msg.mark.name);
          m.run();
        }
      }
    });
    ws.on("close", () => {
      if (this.media === ws) this.media = undefined;
    });
  }

  private afterPlayback(run: () => void) {
    if (!this.media || !this.streamSid) return run();
    const name = randomBytes(6).toString("hex");
    const timer = setTimeout(() => {
      this.marks.delete(name);
      run();
    }, 15_000);
    this.marks.set(name, { run, timer });
    this.media.send(JSON.stringify({ event: "mark", streamSid: this.streamSid, mark: { name } }));
  }

  // ---- actions ----

  private updateCall(twiml: string) {
    if (!this.callSid) return Promise.resolve();
    return twilioApi(this.cfg, `/Calls/${this.callSid}.json`, { Twiml: twiml }).then(() => undefined);
  }

  private async hangUp() {
    if (!this.callSid) return;
    await twilioApi(this.cfg, `/Calls/${this.callSid}.json`, { Status: "completed" }).catch((e: Error) => this.log("system", `Hang-up failed: ${e.message}`));
  }

  /** Rings the callback phone (answering machines are not connected) and moves the support leg into a conference with it. */
  private async join(reason: string) {
    const profile = this.ctx.store.getProfile(this.userId);
    const err = profile.callbackPhone ? dialableError(profile.callbackPhone) : "No callback phone in your Profile";
    if (err) {
      this.log("system", `Cannot ring you: ${err}. The support call stays on the line; ending it.`);
      return this.hangUp();
    }
    const room = `aicaller-${this.callId}`;
    this.log("system", `Ringing ${profile.callbackPhone} to connect you (${reason}).`);
    await this.updateCall(conferenceTwiml(room));
    await twilioApi(this.cfg, "/Calls.json", {
      To: profile.callbackPhone,
      From: this.cfg.fromNumber,
      Url: `${this.cfg.publicUrl}/twilio/join-answer?callId=${this.callId}`,
      MachineDetection: "Enable",
    });
  }

  private async perform(a: BrowserAction) {
    try {
      if (a.type === "press_keys") await this.updateCall(streamTwiml(this.cfg, this.callId, this.mediaToken, `<Play digits="w${a.digits}"/>`));
      else if (a.type === "hand_off") await this.join(a.reason);
      else if (a.type === "hang_up") await this.hangUp();
    } catch (err) {
      this.log("system", `Twilio action ${a.type} failed: ${(err as Error).message}`);
    }
  }

  // ---- overrides of the speakerphone behaviour ----

  protected override deliver(r: TurnResponse): TurnResponse {
    for (const a of r.actions) void this.perform(a);
    return r;
  }

  protected override systemTurn(message: string): Promise<TurnResponse> {
    this.inject(message);
    return Promise.resolve({ say: "", actions: [] });
  }

  override instruct(text: string): Promise<TurnResponse> {
    this.log("user", text);
    this.inject(`[Account holder] ${text}`);
    return Promise.resolve({ say: "", actions: [] });
  }

  override takeOver(reason = "The account holder joined the call"): BrowserAction[] {
    const actions = super.takeOver(reason);
    actions.forEach((a) => void this.perform(a));
    return actions;
  }

  override endByUser(): BrowserAction[] {
    const actions = super.endByUser();
    actions.forEach((a) => void this.perform(a));
    return actions;
  }

  protected override enterHold(reason: string) {
    super.enterHold(reason);
    this.send(this.rt, { type: RT.inputAudioClear });
    this.dgText = [];
    const dg = new WebSocket(
      "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=mulaw&sample_rate=8000&channels=1&punctuate=true&endpointing=500",
      { headers: { Authorization: `Token ${this.cfg.deepgramKey}` } },
    );
    this.dg = dg;
    dg.on("message", (data) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type !== "Results") return;
      const text = String(msg.channel?.alternatives?.[0]?.transcript ?? "").trim();
      if (msg.is_final && text) this.dgText.push(text);
      if (msg.speech_final && this.dgText.length) {
        const utterance = this.dgText.splice(0).join(" ");
        void this.enqueue(() => this.holdHeard(utterance));
      }
    });
    dg.on("error", (err) => this.log("system", `Hold listener error: ${err.message}`));
  }

  protected override leaveHold() {
    super.leaveHold();
    this.closeDeepgram();
  }

  private closeDeepgram() {
    const dg = this.dg;
    this.dg = undefined;
    if (dg?.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "CloseStream" }));
    dg?.close();
  }

  private async holdHeard(text: string) {
    if (this.ended || !this.onHold) return;
    this.log("them", text);
    const verdict = await this.detector.check(text);
    if (!verdict.human) return;
    this.leaveHold();
    this.setStatus("with_human");
    this.inject(`[System] A live person just picked up and said: "${text}"`);
  }

  /** Twilio reported the call ended on its own (hang-up, busy, no answer). */
  remoteEnded(callStatus: string) {
    const failed = ["failed", "busy", "no-answer", "canceled"].includes(callStatus);
    this.finish(failed ? "failed" : "completed", { result: null, summary: `Phone call ended (${callStatus})` });
  }

  fail(reason: string) {
    this.log("system", reason);
    this.finish("failed", { result: null, summary: reason });
    void this.hangUp();
  }

  private closeRealtime() {
    const rt = this.rt;
    this.rt = undefined;
    rt?.close();
  }

  protected override finish(status: CallStatus, end: { result: CallResult | null; summary: string }) {
    if (this.ended) return;
    super.finish(status, end);
    this.closeDeepgram();
    // Inside a response (end_call / transfer_to_user) keep the socket until response.done runs the deferred action.
    if (!this.responding) this.closeRealtime();
  }
}

/** Registers Twilio routes only when PUBLIC_URL, TWILIO_* and the OpenAI/Deepgram keys are all set. */
export async function registerTwilio(app: FastifyInstance, ctx: AppContext): Promise<ExtraChannel | null> {
  const cfg = twilioConfig();
  if (!cfg) return null;
  const sessionFor = (req: FastifyRequest) => {
    const s = getSession(String((req.query as { callId?: string }).callId ?? ""));
    return s instanceof TwilioCallSession ? s : null;
  };
  const signed = (req: FastifyRequest, reply: FastifyReply) => {
    const params = Object.fromEntries(Object.entries((req.body as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)]));
    if (validTwilioRequest(cfg, req.url, params, req.headers["x-twilio-signature"] as string | undefined)) return params;
    void reply.code(403).send("Bad signature");
    return null;
  };
  const twiml = (reply: FastifyReply, body: string) => reply.type("text/xml").send(body);

  app.post("/twilio/voice", async (req, reply) => {
    if (!signed(req, reply)) return reply;
    const s = sessionFor(req);
    if (!s) return twiml(reply, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    return twiml(reply, streamTwiml(cfg, s.callId, s.mediaToken));
  });
  app.post("/twilio/status", async (req, reply) => {
    const params = signed(req, reply);
    if (!params) return reply;
    if (["completed", "failed", "busy", "no-answer", "canceled"].includes(params.CallStatus)) sessionFor(req)?.remoteEnded(params.CallStatus);
    return reply.code(204).send();
  });
  app.post("/twilio/join-answer", async (req, reply) => {
    const params = signed(req, reply);
    if (!params) return reply;
    const callId = String((req.query as { callId?: string }).callId ?? "");
    const hangup = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
    if (!ctx.store.getCall(DEFAULT_USER, callId)) return twiml(reply, hangup);
    if (/^(machine|fax)/.test(params.AnsweredBy ?? "")) {
      const entry = ctx.store.addTranscript(DEFAULT_USER, callId, "system", "Voicemail answered your phone, so it was not connected.");
      ctx.hub.emit(DEFAULT_USER, { type: "transcript", callId, entry });
      return twiml(reply, hangup);
    }
    return twiml(reply, conferenceTwiml(`aicaller-${callId}`, "Connecting you to your support call."));
  });
  app.get("/twilio/media", { websocket: true }, (socket) => {
    const timer = setTimeout(() => socket.close(4401, "no start"), 10_000);
    const onMessage = (data: WebSocket.RawData) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.event !== "start") return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      const p = msg.start?.customParameters ?? {};
      const s = getSession(String(p.callId ?? ""));
      if (!(s instanceof TwilioCallSession) || typeof p.token !== "string" || !safeEqual(p.token, s.mediaToken)) {
        socket.close(4401, "unauthorized");
        return;
      }
      s.attachStream(socket, String(msg.start.streamSid));
    };
    socket.on("message", onMessage);
  });

  return {
    allowHosts: [new URL(cfg.publicUrl).host.toLowerCase()],
    async start(call: CallRecord) {
      const err = dialableError(call.plan.phoneNumber);
      if (err) throw new Error(err);
      const s = new TwilioCallSession(ctx, call, cfg);
      try {
        await s.begin();
      } catch (e) {
        s.fail(`Could not place the call: ${(e as Error).message}`);
        throw e;
      }
    },
  };
}
