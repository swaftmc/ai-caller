"use client";
import { useEffect, useState } from "react";
import { PROVIDER_BASE_URLS, PROVIDERS, type Provider, type SettingsUpdate, type SettingsView } from "@ai-caller/shared";
import { api, SETTINGS_CHANGED } from "@/lib/api";

type Form = Omit<SettingsUpdate, "apiKey" | "sttApiKey" | "ttsApiKey">;
type KeyField = "apiKey" | "sttApiKey" | "ttsApiKey";
const FIELDS = [
  "provider",
  "callModel",
  "planningModel",
  "classifierModel",
  "baseUrl",
  "webSearch",
  "approvalTimeoutSeconds",
  "sttProvider",
  "sttUrl",
  "sttModel",
  "ttsProvider",
  "ttsUrl",
  "ttsModel",
  "ttsVoice",
] as const;
const LABELS: Record<Provider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  groq: "Groq",
  ollama: "Ollama (local, no key)",
  anthropic: "Anthropic (OpenAI-compatible endpoint)",
  custom: "Custom OpenAI-compatible",
};

const toForm = (v: SettingsView): Form => Object.fromEntries(FIELDS.map((f) => [f, v[f]])) as Form;

export default function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [form, setForm] = useState<Form>({});
  const [keys, setKeys] = useState<Record<KeyField, string>>({ apiKey: "", sttApiKey: "", ttsApiKey: "" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const apply = (v: SettingsView) => {
    setView(v);
    setForm(toForm(v));
    setKeys({ apiKey: "", sttApiKey: "", ttsApiKey: "" });
    window.dispatchEvent(new Event(SETTINGS_CHANGED));
  };
  useEffect(() => {
    api<SettingsView>("/settings").then((v) => {
      setView(v);
      setForm(toForm(v));
    }, (e: Error) => setError(e.message));
  }, []);

  const save = async (extra: Partial<SettingsUpdate> = {}) => {
    if (!view) return;
    setError("");
    setMsg("");
    const changed: Record<string, unknown> = {};
    for (const f of FIELDS) if (form[f] !== view[f]) changed[f] = form[f];
    for (const k of Object.keys(keys) as KeyField[]) if (keys[k].trim()) changed[k] = keys[k].trim();
    try {
      apply(await api<SettingsView>("/settings", "PUT", { ...changed, ...extra }));
      setMsg("Saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!view) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const provider = (form.provider ?? view.provider) as Provider;
  const keyInput = (field: KeyField, has: boolean, label: string) => (
    <label>
      {label}
      <div className="row">
        <input
          type="password"
          autoComplete="off"
          placeholder={has ? "saved (type to replace)" : "not set"}
          value={keys[field]}
          onChange={(e) => setKeys({ ...keys, [field]: e.target.value })}
          style={{ flex: 1 }}
        />
        {has && (
          <button type="button" className="secondary" onClick={() => void save({ [field]: "" })}>
            Remove
          </button>
        )}
      </div>
    </label>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h1>Settings</h1>
      <div className="card stack">
        <h2>Language model</h2>
        <div className="grid">
          <label>
            Provider
            <select value={provider} onChange={(e) => set("provider", e.target.value as Provider)}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          {keyInput("apiKey", view.hasApiKey, provider === "ollama" ? "API key (not needed for Ollama)" : "API key")}
          <label>
            Call model
            <input value={form.callModel ?? ""} onChange={(e) => set("callModel", e.target.value)} placeholder="e.g. openai/gpt-4o-mini" />
          </label>
          <label>
            Planning and summary model (optional)
            <input value={form.planningModel ?? ""} onChange={(e) => set("planningModel", e.target.value)} placeholder="same as call model" />
          </label>
          <label>
            Hold classifier model (optional)
            <input value={form.classifierModel ?? ""} onChange={(e) => set("classifierModel", e.target.value)} placeholder="same as planning model" />
          </label>
          <label>
            Base URL override
            <input
              value={form.baseUrl ?? ""}
              onChange={(e) => set("baseUrl", e.target.value)}
              placeholder={provider === "custom" ? "required, e.g. http://localhost:1234/v1" : PROVIDER_BASE_URLS[provider]}
            />
          </label>
          <label>
            Approval timeout (seconds)
            <input
              type="number"
              min={15}
              max={3600}
              value={form.approvalTimeoutSeconds ?? 180}
              onChange={(e) => set("approvalTimeoutSeconds", Number(e.target.value) || 180)}
            />
          </label>
          {provider === "openrouter" && (
            <label className="check">
              <input type="checkbox" checked={Boolean(form.webSearch)} onChange={(e) => set("webSearch", e.target.checked)} />
              Let the planner search the web for support numbers
            </label>
          )}
        </div>
      </div>

      <div className="card stack">
        <h2>Speech recognition</h2>
        <div className="grid">
          <label>
            Provider
            <select value={form.sttProvider} onChange={(e) => set("sttProvider", e.target.value as Form["sttProvider"])}>
              <option value="browser">Browser (Chrome or Edge)</option>
              <option value="openai_compatible">OpenAI-compatible transcription API</option>
            </select>
          </label>
          {form.sttProvider === "openai_compatible" && (
            <>
              <label>
                Base URL
                <input value={form.sttUrl ?? ""} onChange={(e) => set("sttUrl", e.target.value)} placeholder="e.g. https://api.openai.com/v1" />
              </label>
              {keyInput("sttApiKey", view.sttHasKey, "API key")}
              <label>
                Model
                <input value={form.sttModel ?? ""} onChange={(e) => set("sttModel", e.target.value)} />
              </label>
            </>
          )}
        </div>
      </div>

      <div className="card stack">
        <h2>Voice</h2>
        <div className="grid">
          <label>
            Provider
            <select value={form.ttsProvider} onChange={(e) => set("ttsProvider", e.target.value as Form["ttsProvider"])}>
              <option value="browser">Browser voice</option>
              <option value="openai_compatible">OpenAI-compatible speech API</option>
            </select>
          </label>
          {form.ttsProvider === "openai_compatible" && (
            <>
              <label>
                Base URL
                <input value={form.ttsUrl ?? ""} onChange={(e) => set("ttsUrl", e.target.value)} placeholder="e.g. https://api.openai.com/v1" />
              </label>
              {keyInput("ttsApiKey", view.ttsHasKey, "API key")}
              <label>
                Model
                <input value={form.ttsModel ?? ""} onChange={(e) => set("ttsModel", e.target.value)} />
              </label>
              <label>
                Voice
                <input value={form.ttsVoice ?? ""} onChange={(e) => set("ttsVoice", e.target.value)} />
              </label>
            </>
          )}
        </div>
      </div>

      <div className="row">
        <button type="submit">Save settings</button>
        {view.configured ? <span className="badge good">Ready for calls</span> : <span className="badge waiting">Choose a call model and API key</span>}
        {msg && <span className="muted">{msg}</span>}
      </div>
      {error && <pre className="error">{error}</pre>}
    </form>
  );
}
