import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import {
  ENDED_STATUSES,
  type BrowserAction,
  type CallOutcome,
  type CallPlan,
  type CallRecord,
  type CallResult,
  type CallStatus,
  type Speaker,
  type TurnResponse,
} from "@ai-caller/shared";
import type { Store } from "./db.js";
import type { Hub } from "./events.js";
import { ClassifierSchema, HumanDetector } from "./humanDetector.js";
import { askJson, classifierModel, makeClient, planningModel } from "./llm.js";
import { CLASSIFIER_PROMPT, callSystemPrompt, summaryPrompt, toolsFor } from "./prompt.js";
import { getSettings, isConfigured } from "./settings.js";

export interface AppContext {
  store: Store;
  hub: Hub;
}

export const MAX_LIVE_CALLS = 3;
const MAX_ROUNDS = 4;
const TERMINAL_TOOLS = new Set(["wait", "send_dtmf", "enter_hold_mode", "transfer_to_user", "end_call"]);

export interface ToolOutcome {
  output: Record<string, unknown>;
  action?: BrowserAction;
}

const sessions = new Map<string, CallSession>();
export const getSession = (callId: string) => sessions.get(callId);

/** Live state of one call: a serialized turn queue around chat-completions history, hold mode and approvals. */
export class CallSession {
  readonly callId: string;
  readonly plan: CallPlan;
  ended = false;
  /** Resolves when the post-call summary and playbook are written. */
  done: Promise<void> = Promise.resolve();
  protected messages: ChatCompletionMessageParam[];
  protected onHold = false;
  protected status: CallStatus;
  protected detector: HumanDetector;
  private queue: Promise<unknown> = Promise.resolve();
  private holdTimer?: NodeJS.Timeout;
  private approvalTimers = new Map<string, NodeJS.Timeout>();
  private endResult: { result: CallResult | null; summary: string } = { result: null, summary: "" };

  constructor(
    protected ctx: AppContext,
    readonly userId: string,
    call: CallRecord,
  ) {
    this.callId = call.id;
    this.plan = call.plan;
    this.status = call.status;
    const profile = ctx.store.getProfile(userId);
    this.messages = [
      {
        role: "system",
        content: callSystemPrompt({
          plan: call.plan,
          holderName: profile.name,
          playbook: ctx.store.getPlaybook(userId, call.plan.company),
          channel: call.plan.channel,
        }),
      },
    ];
    this.detector = new HumanDetector(async (text) => {
      const s = getSettings(ctx.store, userId);
      return askJson({
        client: makeClient(s),
        model: classifierModel(s),
        system: CLASSIFIER_PROMPT,
        messages: [{ role: "user", content: text }],
        schema: ClassifierSchema,
        maxTokens: 60,
        retries: 1,
      });
    });
    sessions.set(this.callId, this);
  }

  static start(ctx: AppContext, userId: string, call: CallRecord): CallSession {
    const s = new CallSession(ctx, userId, call);
    s.setStatus("dialing");
    s.log("system", "Call started. Dial the number on your phone, put it on speaker and press Start listening.");
    return s;
  }

  // ---- inputs ----

  /** Text recognized from the other side of the call. */
  heard(text: string): Promise<TurnResponse> {
    return this.enqueue(() => this.onHeard(text));
  }

  /** "Tell the AI" instruction from the account holder; the reply goes out as local_output. */
  instruct(text: string): Promise<TurnResponse> {
    this.log("user", text);
    return this.enqueue(async () => {
      this.messages.push({ role: "user", content: `[Account holder] ${text}` });
      return this.deliver(await this.runTurn());
    });
  }

  decideApproval(approvalId: string, decision: "approve" | "deny", note: string | null) {
    const a = this.ctx.store.getApproval(approvalId);
    if (!a || a.callId !== this.callId) return null;
    const resolved = this.ctx.store.resolveApproval(approvalId, decision === "approve" ? "approved" : "denied", note);
    if (!resolved) return null;
    clearTimeout(this.approvalTimers.get(approvalId));
    this.approvalTimers.delete(approvalId);
    this.ctx.hub.emit(this.userId, { type: "approval", callId: this.callId, approval: resolved });
    const verb = decision === "approve" ? "APPROVED" : "DENIED";
    this.log("system", `Account holder ${verb.toLowerCase()} request ${approvalId}${note ? `: ${note}` : ""}`);
    if (!this.hasPendingApprovals()) this.setStatus("with_human");
    void this.systemTurn(`[System] The account holder ${verb} request ${approvalId}.${note ? ` Their note: ${note}` : ""}`);
    return resolved;
  }

  /** The account holder takes over the call; the AI stops. */
  takeOver(reason = "The account holder took over the call"): BrowserAction[] {
    this.finish("transferred", { result: null, summary: reason });
    return [{ type: "hand_off", reason }];
  }

  endByUser(): BrowserAction[] {
    this.finish("canceled", { result: null, summary: "The account holder ended the call." });
    return [{ type: "hang_up", reason: "Ended by the account holder" }];
  }

  // ---- turn machinery ----

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  protected async onHeard(text: string): Promise<TurnResponse> {
    if (this.ended) return { say: "", actions: [] };
    this.log("them", text);
    if (this.status === "dialing") this.setStatus("navigating");
    if (this.onHold) {
      const verdict = await this.detector.check(text);
      if (!verdict.human) return { say: "", actions: [] };
      this.leaveHold();
      this.setStatus("with_human");
      this.messages.push({ role: "user", content: `[System] A live person just picked up and said: "${text}"` });
      const r = await this.runTurn();
      return { say: r.say, actions: [{ type: "hold", on: false }, ...r.actions] };
    }
    this.messages.push({ role: "user", content: `[Them] ${text}` });
    return this.runTurn();
  }

  /** Runs a model turn for a software event (approval result, timeout) and pushes it to the browser. */
  protected systemTurn(message: string): Promise<TurnResponse> {
    return this.enqueue(async () => {
      if (this.ended) return { say: "", actions: [] };
      this.messages.push({ role: "user", content: message });
      return this.deliver(await this.runTurn());
    });
  }

  protected deliver(r: TurnResponse): TurnResponse {
    if (r.say || r.actions.length) this.ctx.hub.emit(this.userId, { type: "local_output", callId: this.callId, ...r });
    return r;
  }

  private trimHistory() {
    if (this.messages.length <= 80) return;
    let start = this.messages.length - 60;
    while (start < this.messages.length && this.messages[start].role !== "user") start++;
    this.messages = [this.messages[0], ...this.messages.slice(start)];
  }

  protected async runTurn(): Promise<TurnResponse> {
    const said: string[] = [];
    const actions: BrowserAction[] = [];
    try {
      const s = getSettings(this.ctx.store, this.userId);
      const client = makeClient(s);
      for (let round = 0; round < MAX_ROUNDS && !this.ended; round++) {
        this.trimHistory();
        const res = await client.chat.completions.create({
          model: s.callModel,
          messages: this.messages,
          tools: toolsFor(this.plan.autonomy),
          max_tokens: 400,
        });
        const msg = res.choices[0]?.message;
        if (!msg) break;
        const calls = (msg.tool_calls ?? []).filter((t) => t.type === "function");
        const text = (msg.content ?? "").replace(/[*_#`]/g, "").trim();
        this.messages.push(calls.length ? { role: "assistant", content: msg.content ?? "", tool_calls: calls } : { role: "assistant", content: msg.content ?? "" });
        if (text) {
          said.push(text);
          this.log("ai", text);
        }
        if (!calls.length) break;
        let terminal = false;
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            // the tool sees empty args and returns a validation error
          }
          const outcome = this.executeTool(call.function.name, args);
          if (outcome.action) actions.push(outcome.action);
          this.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.output) });
          if (TERMINAL_TOOLS.has(call.function.name)) terminal = true;
        }
        if (terminal) break;
      }
    } catch (err) {
      console.error(`[call ${this.callId}] model turn failed:`, (err as Error).message);
      this.log("system", `The AI model request failed: ${(err as Error).message}`);
    }
    return { say: said.join(" "), actions };
  }

  // ---- tools (server-side enforcement lives here) ----

  executeTool(name: string, args: Record<string, unknown>): ToolOutcome {
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
    const detailTools = ["get_account_detail", "request_approval", "record_commitment"];
    if (this.ended) return { output: { error: "The call has ended." } };
    if (detailTools.includes(name) && this.plan.autonomy === "explain_only") {
      this.audit(`${name}_denied`, { reason: "explain_only" });
      return { output: { error: "Not allowed: autonomy is explain_only." } };
    }
    switch (name) {
      case "send_dtmf": {
        const digits = str("digits").replace(/[^0-9*#]/g, "").slice(0, 32);
        if (!digits) return { output: { error: "digits must contain 0-9, * or #" } };
        this.log("system", `Pressing ${digits}`);
        if (this.status === "dialing") this.setStatus("navigating");
        return { output: { ok: true, pressed: digits }, action: { type: "press_keys", digits } };
      }
      case "wait":
        return { output: { ok: true } };
      case "enter_hold_mode": {
        this.enterHold(str("reason"));
        return { output: { ok: true, note: "You will not be called again until a live person answers." }, action: { type: "hold", on: true } };
      }
      case "mark_human_reached": {
        const wasOnHold = this.onHold;
        if (wasOnHold) this.leaveHold();
        if (this.status !== "awaiting_approval") this.setStatus("with_human");
        return { output: { ok: true }, action: wasOnHold ? { type: "hold", on: false } : undefined };
      }
      case "note_info": {
        const info = str("info");
        if (!info) return { output: { error: "info is required" } };
        this.log("system", `Noted: ${info}`);
        return { output: { ok: true } };
      }
      case "transfer_to_user": {
        const reason = str("reason") || "The AI handed the call to you";
        this.finish("transferred", { result: null, summary: reason });
        return { output: { ok: true }, action: { type: "hand_off", reason } };
      }
      case "end_call": {
        const result = z.enum(["resolved", "partially_resolved", "unresolved"]).catch("unresolved").parse(args.result);
        const summary = str("summary");
        this.finish("completed", { result, summary });
        return { output: { ok: true }, action: { type: "hang_up", reason: summary || "Call finished" } };
      }
      case "get_account_detail": {
        const key = str("key");
        if (!this.plan.sharedDetailKeys.includes(key)) {
          this.audit("detail_denied", { key, reason: "not in sharedDetailKeys" });
          this.log("system", `Blocked the AI from reading stored detail "${key}" (not shared for this call)`);
          return { output: { error: `Not allowed. Shareable keys: ${this.plan.sharedDetailKeys.join(", ") || "none"}` } };
        }
        const value = this.ctx.store.getDetailValue(this.userId, key);
        if (value === null) {
          this.audit("detail_missing", { key });
          return { output: { error: `No stored detail named ${key}` } };
        }
        this.audit("detail_read", { key });
        this.log("system", `AI read stored detail "${key}" to share on the call`);
        return { output: { key, value } };
      }
      case "request_approval": {
        const question = str("question");
        if (!question) return { output: { error: "question is required" } };
        const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === "string").slice(0, 6) : [];
        const approval = this.ctx.store.createApproval(this.userId, this.callId, question, options);
        this.audit("approval_requested", { approvalId: approval.id, question });
        this.log("system", `Asked you to approve: ${question}`);
        this.ctx.hub.emit(this.userId, { type: "approval", callId: this.callId, approval });
        this.setStatus("awaiting_approval");
        this.scheduleApprovalTimeout(approval.id);
        return {
          output: {
            approval_id: approval.id,
            status: "pending",
            instruction: "Tell them in one sentence that you are checking with the account holder, then call wait. Do not agree to anything until a [System] message gives the decision.",
          },
        };
      }
      case "record_commitment": {
        const description = str("description");
        const approvalId = str("approval_id");
        const rule = typeof args.rule_number === "number" ? args.rule_number : Number.NaN;
        const approval = approvalId ? this.ctx.store.getApproval(approvalId) : null;
        const approved = approval?.callId === this.callId && approval.status === "approved";
        const ruleOk = this.plan.autonomy === "act_within_rules" && Number.isInteger(rule) && rule >= 1 && rule <= this.plan.rules.length;
        if (!description || (!approved && !ruleOk)) {
          const reason = !description ? "missing description" : approvalId ? `approval ${approvalId} is not approved for this call` : "no approved request or valid rule number";
          this.audit("commitment_rejected", { description, approvalId: approvalId || null, ruleNumber: Number.isNaN(rule) ? null : rule, reason });
          this.log("system", `Blocked a commitment: ${description || "(none)"} (${reason})`);
          return { output: { error: `Rejected: ${reason}. Do not agree to this. Use request_approval first.` } };
        }
        const basis = approved ? { approvalId } : { ruleNumber: rule };
        this.audit("commitment_recorded", { description, ...basis });
        this.log("system", `Commitment recorded: ${description} (${approved ? `approval ${approvalId}` : `rule ${rule}`})`);
        return { output: { ok: true, recorded: description } };
      }
      default:
        return { output: { error: `Unknown tool ${name}` } };
    }
  }

  // ---- hold, approvals, status ----

  protected enterHold(reason: string) {
    this.onHold = true;
    this.detector.reset();
    this.setStatus("on_hold");
    this.log("system", `On hold${reason ? `: ${reason}` : ""}. Listening for a live person.`);
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => void this.enqueue(async () => this.holdExpired()), this.plan.maxHoldMinutes * 60_000);
  }

  protected leaveHold() {
    this.onHold = false;
    clearTimeout(this.holdTimer);
  }

  protected async holdExpired(): Promise<TurnResponse> {
    if (this.ended || !this.onHold) return { say: "", actions: [] };
    const reason = `Gave up after ${this.plan.maxHoldMinutes} minutes on hold`;
    this.log("system", reason);
    this.finish("completed", { result: "unresolved", summary: reason });
    return this.deliver({ say: "", actions: [{ type: "hang_up", reason }] });
  }

  private hasPendingApprovals() {
    return this.ctx.store.listApprovals(this.callId).some((a) => a.status === "pending");
  }

  private scheduleApprovalTimeout(approvalId: string) {
    const seconds = getSettings(this.ctx.store, this.userId).approvalTimeoutSeconds;
    const timer = setTimeout(() => {
      this.approvalTimers.delete(approvalId);
      const expired = this.ctx.store.resolveApproval(approvalId, "expired", "No response in time");
      if (!expired || this.ended) return;
      this.ctx.hub.emit(this.userId, { type: "approval", callId: this.callId, approval: expired });
      this.log("system", `Approval request ${approvalId} expired`);
      if (!this.hasPendingApprovals()) this.setStatus("with_human");
      void this.systemTurn(`[System] The account holder did not respond to request ${approvalId} in time. Do not agree to it; say the account holder will follow up.`);
    }, seconds * 1000);
    this.approvalTimers.set(approvalId, timer);
  }

  protected setStatus(status: CallStatus) {
    if (this.status === status || (this.ended && !ENDED_STATUSES.includes(status))) return;
    this.status = status;
    this.ctx.store.setStatus(this.callId, status);
    this.ctx.hub.emit(this.userId, { type: "status", callId: this.callId, status });
  }

  protected log(speaker: Speaker, text: string) {
    const entry = this.ctx.store.addTranscript(this.userId, this.callId, speaker, text);
    this.ctx.hub.emit(this.userId, { type: "transcript", callId: this.callId, entry });
  }

  protected audit(kind: string, detail: Record<string, unknown>) {
    this.ctx.store.audit(this.userId, this.callId, kind, detail);
  }

  /** Ends the AI's part of the call: stops timers, expires approvals, sets the final status, writes the outcome. */
  protected finish(status: CallStatus, end: { result: CallResult | null; summary: string }) {
    if (this.ended) return;
    this.endResult = end;
    clearTimeout(this.holdTimer);
    for (const t of this.approvalTimers.values()) clearTimeout(t);
    this.approvalTimers.clear();
    for (const a of this.ctx.store.listApprovals(this.callId)) {
      if (a.status !== "pending") continue;
      const expired = this.ctx.store.resolveApproval(a.id, "expired", "Call ended");
      if (expired) this.ctx.hub.emit(this.userId, { type: "approval", callId: this.callId, approval: expired });
    }
    this.setStatus(status);
    this.ended = true;
    sessions.delete(this.callId);
    this.done = writeOutcome(this.ctx, this.userId, this.callId, this.plan, this.endResult).catch((err) => {
      console.error(`[call ${this.callId}] summary failed:`, (err as Error).message);
      this.log("system", `Could not write the call summary: ${(err as Error).message}`);
    });
  }
}

const SummarySchema = z.object({
  summary: z.string(),
  referenceNumbers: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  playbook: z.object({ menuPaths: z.array(z.string()).default([]), tactics: z.array(z.string()).default([]) }),
});

const LABEL: Record<Speaker, string> = { them: "Them", ai: "AI", system: "System", user: "Account holder" };

/** Post-call: summary, reference numbers, follow-ups, and the company playbook (with personal data filtered out). */
async function writeOutcome(ctx: AppContext, userId: string, callId: string, plan: CallPlan, end: { result: CallResult | null; summary: string }) {
  const s = getSettings(ctx.store, userId);
  let outcome: CallOutcome = { result: end.result, summary: end.summary, referenceNumbers: [], followUps: [] };
  if (isConfigured(s)) {
    const transcript = ctx.store
      .listTranscript(callId)
      .map((e) => `${LABEL[e.speaker]}: ${e.text}`)
      .join("\n")
      .slice(-30_000);
    const previous = ctx.store.getPlaybook(userId, plan.company);
    const out = await askJson({
      client: makeClient(s),
      model: planningModel(s),
      system: summaryPrompt(plan.company, previous),
      messages: [
        {
          role: "user",
          content: `Issue: ${plan.issue}\nDesired outcome: ${plan.desiredOutcome}\nResult reported by the AI: ${end.result ?? "none"}\nAI's summary: ${end.summary || "none"}\n\nTranscript:\n${transcript}`,
        },
      ],
      schema: SummarySchema,
    });
    outcome = { result: end.result, summary: out.summary, referenceNumbers: out.referenceNumbers, followUps: out.followUps };
    const profile = ctx.store.getProfile(userId);
    const banned = [
      ...profile.name.split(/\s+/),
      profile.callbackPhone,
      ...ctx.store.detailKeys(userId).map((k) => ctx.store.getDetailValue(userId, k) ?? ""),
      ...out.referenceNumbers,
    ]
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length >= 3);
    const clean = (items: string[]) =>
      items
        .map((i) => i.trim())
        .filter((i) => i && !/\d{5,}/.test(i.replace(/[\s-]/g, "")) && !banned.some((b) => i.toLowerCase().includes(b)))
        .slice(0, 10);
    ctx.store.savePlaybook(userId, plan.company, clean(out.playbook.menuPaths), clean(out.playbook.tactics));
  }
  ctx.store.setOutcome(callId, outcome);
  ctx.hub.emit(userId, { type: "outcome", callId, outcome });
}
