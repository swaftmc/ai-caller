import { z } from "zod";

export const CALL_STATUSES = [
  "draft",
  "dialing",
  "navigating",
  "on_hold",
  "with_human",
  "awaiting_approval",
  "transferred",
  "completed",
  "failed",
  "canceled",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
export const LIVE_STATUSES: readonly CallStatus[] = ["dialing", "navigating", "on_hold", "with_human", "awaiting_approval"];
export const ENDED_STATUSES: readonly CallStatus[] = ["transferred", "completed", "failed", "canceled"];

export const ModeSchema = z.enum(["handoff", "resolve"]);
export type Mode = z.infer<typeof ModeSchema>;
export const AutonomySchema = z.enum(["explain_only", "approve_decisions", "act_within_rules"]);
export type Autonomy = z.infer<typeof AutonomySchema>;
export const ChannelSchema = z.enum(["speakerphone", "twilio"]);
export type Channel = z.infer<typeof ChannelSchema>;
export const CallResultSchema = z.enum(["resolved", "partially_resolved", "unresolved"]);
export type CallResult = z.infer<typeof CallResultSchema>;

export const E164 = /^\+[1-9]\d{6,14}$/;

export const CallPlanSchema = z.object({
  company: z.string().trim().min(1),
  phoneNumber: z.string().trim().regex(E164, "phoneNumber must be E.164, e.g. +18005551234"),
  phoneNumberSource: z.string().trim().default(""),
  issue: z.string().trim().min(1),
  desiredOutcome: z.string().trim().min(1),
  context: z.array(z.string()).default([]),
  mode: ModeSchema.default("handoff"),
  autonomy: AutonomySchema.default("explain_only"),
  rules: z.array(z.string()).default([]),
  disclosure: z.boolean().default(true),
  sharedDetailKeys: z.array(z.string()).default([]),
  maxHoldMinutes: z.number().int().min(1).max(240).default(45),
  channel: ChannelSchema.default("speakerphone"),
});
export type CallPlan = z.infer<typeof CallPlanSchema>;

export const ChatMessageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export const IntakeRequestSchema = z.object({ messages: z.array(ChatMessageSchema).min(1).max(60) });
export const IntakeReplySchema = z.object({ reply: z.string(), plan: CallPlanSchema.nullable() });
export type IntakeReply = z.infer<typeof IntakeReplySchema>;

export type Speaker = "them" | "ai" | "system" | "user";
export interface TranscriptEntry {
  id: number;
  callId: string;
  speaker: Speaker;
  text: string;
  createdAt: string;
}

export interface CallOutcome {
  result: CallResult | null;
  summary: string;
  referenceNumbers: string[];
  followUps: string[];
}

export interface CallRecord {
  id: string;
  status: CallStatus;
  plan: CallPlan;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  outcome: CallOutcome | null;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export interface Approval {
  id: string;
  callId: string;
  question: string;
  options: string[];
  status: ApprovalStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  note: z.string().max(1000).optional(),
});

export type BrowserAction =
  | { type: "press_keys"; digits: string }
  | { type: "hold"; on: boolean }
  | { type: "hand_off"; reason: string }
  | { type: "hang_up"; reason: string };
export interface TurnResponse {
  say: string;
  actions: BrowserAction[];
}

export const HeardSchema = z.object({ text: z.string().trim().min(1).max(4000) });
export const InstructionSchema = z.object({ text: z.string().trim().min(1).max(2000) });

export type WsEvent =
  | { type: "status"; callId: string; status: CallStatus }
  | { type: "transcript"; callId: string; entry: TranscriptEntry }
  | { type: "approval"; callId: string; approval: Approval }
  | { type: "outcome"; callId: string; outcome: CallOutcome }
  | { type: "local_output"; callId: string; say: string; actions: BrowserAction[] };

export const PROVIDERS = ["openrouter", "openai", "groq", "ollama", "anthropic", "custom"] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;
export const PROVIDER_BASE_URLS: Record<Exclude<Provider, "custom">, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
  anthropic: "https://api.anthropic.com/v1/",
};
export const SpeechProviderSchema = z.enum(["browser", "openai_compatible"]);
export type SpeechProvider = z.infer<typeof SpeechProviderSchema>;

export interface SettingsView {
  provider: Provider;
  hasApiKey: boolean;
  callModel: string;
  planningModel: string;
  classifierModel: string;
  baseUrl: string;
  effectiveBaseUrl: string;
  webSearch: boolean;
  approvalTimeoutSeconds: number;
  sttProvider: SpeechProvider;
  sttUrl: string;
  sttHasKey: boolean;
  sttModel: string;
  ttsProvider: SpeechProvider;
  ttsUrl: string;
  ttsHasKey: boolean;
  ttsModel: string;
  ttsVoice: string;
  configured: boolean;
  twilioEnabled: boolean;
}

const optStr = z.string().max(500).optional();
export const SettingsUpdateSchema = z
  .object({
    provider: ProviderSchema.optional(),
    apiKey: z.string().max(500).optional(),
    callModel: optStr,
    planningModel: optStr,
    classifierModel: optStr,
    baseUrl: optStr,
    webSearch: z.boolean().optional(),
    approvalTimeoutSeconds: z.number().int().min(15).max(3600).optional(),
    sttProvider: SpeechProviderSchema.optional(),
    sttUrl: optStr,
    sttApiKey: z.string().max(500).optional(),
    sttModel: optStr,
    ttsProvider: SpeechProviderSchema.optional(),
    ttsUrl: optStr,
    ttsApiKey: z.string().max(500).optional(),
    ttsModel: optStr,
    ttsVoice: optStr,
  })
  .strict();
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

export interface Profile {
  name: string;
  callbackPhone: string;
}
export const ProfileUpdateSchema = z.object({
  name: z.string().trim().max(200).optional(),
  callbackPhone: z.union([z.literal(""), z.string().trim().regex(E164, "callbackPhone must be E.164")]).optional(),
});
export interface AccountDetailView {
  key: string;
  masked: string;
  createdAt: string;
}
export const AccountDetailCreateSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,60}$/, "key must be lowercase letters, digits or _"),
  value: z.string().min(1).max(500),
});

export interface Playbook {
  company: string;
  menuPaths: string[];
  tactics: string[];
  updatedAt: string;
}
