import {
  PROVIDER_BASE_URLS,
  ProviderSchema,
  SpeechProviderSchema,
  type Provider,
  type SettingsUpdate,
  type SettingsView,
  type SpeechProvider,
} from "@ai-caller/shared";
import type { Store } from "./db.js";

export interface EffectiveSettings {
  provider: Provider;
  apiKey: string;
  callModel: string;
  planningModel: string;
  classifierModel: string;
  baseUrl: string;
  webSearch: boolean;
  approvalTimeoutSeconds: number;
  sttProvider: SpeechProvider;
  sttUrl: string;
  sttApiKey: string;
  sttModel: string;
  ttsProvider: SpeechProvider;
  ttsUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
}
type Key = keyof EffectiveSettings;

const ENV: Record<Key, string> = {
  provider: "LLM_PROVIDER",
  apiKey: "LLM_API_KEY",
  callModel: "LLM_MODEL",
  planningModel: "LLM_PLANNING_MODEL",
  classifierModel: "LLM_CLASSIFIER_MODEL",
  baseUrl: "LLM_BASE_URL",
  webSearch: "LLM_WEB_SEARCH",
  approvalTimeoutSeconds: "APPROVAL_TIMEOUT_SECONDS",
  sttProvider: "STT_PROVIDER",
  sttUrl: "STT_URL",
  sttApiKey: "STT_API_KEY",
  sttModel: "STT_MODEL",
  ttsProvider: "TTS_PROVIDER",
  ttsUrl: "TTS_URL",
  ttsApiKey: "TTS_API_KEY",
  ttsModel: "TTS_MODEL",
  ttsVoice: "TTS_VOICE",
};
const DEFAULTS: Record<Key, string> = {
  provider: "openrouter",
  apiKey: "",
  callModel: "",
  planningModel: "",
  classifierModel: "",
  baseUrl: "",
  webSearch: "true",
  approvalTimeoutSeconds: "180",
  sttProvider: "browser",
  sttUrl: "",
  sttApiKey: "",
  sttModel: "whisper-1",
  ttsProvider: "browser",
  ttsUrl: "",
  ttsApiKey: "",
  ttsModel: "tts-1",
  ttsVoice: "alloy",
};
const SECRET_KEYS = new Set<Key>(["apiKey", "sttApiKey", "ttsApiKey"]);
const UPDATE_TO_KEY: Record<keyof SettingsUpdate, Key> = {
  provider: "provider",
  apiKey: "apiKey",
  callModel: "callModel",
  planningModel: "planningModel",
  classifierModel: "classifierModel",
  baseUrl: "baseUrl",
  webSearch: "webSearch",
  approvalTimeoutSeconds: "approvalTimeoutSeconds",
  sttProvider: "sttProvider",
  sttUrl: "sttUrl",
  sttApiKey: "sttApiKey",
  sttModel: "sttModel",
  ttsProvider: "ttsProvider",
  ttsUrl: "ttsUrl",
  ttsApiKey: "ttsApiKey",
  ttsModel: "ttsModel",
  ttsVoice: "ttsVoice",
};

/** Resolves each setting with precedence: saved in dashboard > environment/.env > default. */
export function getSettings(store: Store, userId: string): EffectiveSettings {
  const saved = store.getSettingsRaw(userId);
  const pick = (k: Key): string => {
    if (saved[k] !== undefined) return SECRET_KEYS.has(k) ? store.cipher.decrypt(saved[k]) : saved[k];
    return process.env[ENV[k]]?.trim() || DEFAULTS[k];
  };
  const provider = ProviderSchema.catch("openrouter").parse(pick("provider"));
  const timeout = Number.parseInt(pick("approvalTimeoutSeconds"), 10);
  return {
    provider,
    apiKey: pick("apiKey"),
    callModel: pick("callModel"),
    planningModel: pick("planningModel"),
    classifierModel: pick("classifierModel"),
    baseUrl: pick("baseUrl"),
    webSearch: pick("webSearch") === "true",
    approvalTimeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : 180,
    sttProvider: SpeechProviderSchema.catch("browser").parse(pick("sttProvider")),
    sttUrl: pick("sttUrl"),
    sttApiKey: pick("sttApiKey"),
    sttModel: pick("sttModel"),
    ttsProvider: SpeechProviderSchema.catch("browser").parse(pick("ttsProvider")),
    ttsUrl: pick("ttsUrl"),
    ttsApiKey: pick("ttsApiKey"),
    ttsModel: pick("ttsModel"),
    ttsVoice: pick("ttsVoice"),
  };
}

export function effectiveBaseUrl(s: EffectiveSettings): string {
  return s.baseUrl || (s.provider === "custom" ? "" : PROVIDER_BASE_URLS[s.provider]);
}

export function isConfigured(s: EffectiveSettings): boolean {
  return Boolean(s.callModel && effectiveBaseUrl(s) && (s.apiKey || s.provider === "ollama"));
}

export const sttEnabled = (s: EffectiveSettings) => s.sttProvider === "openai_compatible" && Boolean(s.sttUrl && s.sttModel);
export const ttsEnabled = (s: EffectiveSettings) => s.ttsProvider === "openai_compatible" && Boolean(s.ttsUrl && s.ttsModel);

/** Browser-safe view: API keys are reduced to hasKey booleans. */
export function settingsView(s: EffectiveSettings, twilioEnabled: boolean): SettingsView {
  return {
    provider: s.provider,
    hasApiKey: Boolean(s.apiKey),
    callModel: s.callModel,
    planningModel: s.planningModel,
    classifierModel: s.classifierModel,
    baseUrl: s.baseUrl,
    effectiveBaseUrl: effectiveBaseUrl(s),
    webSearch: s.webSearch,
    approvalTimeoutSeconds: s.approvalTimeoutSeconds,
    sttProvider: s.sttProvider,
    sttUrl: s.sttUrl,
    sttHasKey: Boolean(s.sttApiKey),
    sttModel: s.sttModel,
    ttsProvider: s.ttsProvider,
    ttsUrl: s.ttsUrl,
    ttsHasKey: Boolean(s.ttsApiKey),
    ttsModel: s.ttsModel,
    ttsVoice: s.ttsVoice,
    configured: isConfigured(s),
    serverStt: sttEnabled(s),
    serverTts: ttsEnabled(s),
    twilioEnabled,
  };
}

/** Saves provided fields; "" removes the saved value (for keys: deletes the key). Omitted fields are unchanged. */
export function applySettingsUpdate(store: Store, userId: string, update: SettingsUpdate) {
  for (const [field, value] of Object.entries(update) as [keyof SettingsUpdate, string | number | boolean | undefined][]) {
    if (value === undefined) continue;
    const key = UPDATE_TO_KEY[field];
    const text = String(value).trim();
    if (text === "") store.setSetting(userId, key, null);
    else store.setSetting(userId, key, SECRET_KEYS.has(key) ? store.cipher.encrypt(text) : text);
  }
}
