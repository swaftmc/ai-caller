import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { guardedFetch } from "./netguard.js";
import { effectiveBaseUrl, type EffectiveSettings } from "./settings.js";

/** An OpenAI-compatible client whose requests go through the public-address guard. */
export function guardedClient(baseURL: string, apiKey: string, timeout = 60_000, defaultHeaders?: Record<string, string>): OpenAI {
  return new OpenAI({ apiKey: apiKey || "not-needed", baseURL, defaultHeaders, maxRetries: 1, timeout, fetch: guardedFetch });
}

/** One chat-completions client for every provider; OpenRouter also gets its attribution headers. */
export function makeClient(s: EffectiveSettings): OpenAI {
  const attribution = { "HTTP-Referer": process.env.PUBLIC_URL || "https://github.com/swaftmc/ai-caller", "X-Title": "AI Caller" };
  return guardedClient(effectiveBaseUrl(s), s.apiKey, 60_000, s.provider === "openrouter" ? attribution : undefined);
}

export const planningModel = (s: EffectiveSettings) => s.planningModel || s.callModel;
export const classifierModel = (s: EffectiveSettings) => s.classifierModel || planningModel(s);

/** Strips code fences and returns the first balanced {...} object in the text. */
export function parseJsonLoose(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    // fall through to extraction
  }
  const start = unfenced.indexOf("{");
  if (start < 0) throw new Error("no JSON object found");
  let depth = 0;
  let inString = false;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(unfenced.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object");
}

export interface AskJsonOptions<T> {
  client: OpenAI;
  model: string;
  system: string;
  messages: ChatCompletionMessageParam[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  retries?: number;
}

/** Asks for a JSON object, validates it with zod, retries with the error, and drops response_format if the provider rejects it. */
export async function askJson<T>(o: AskJsonOptions<T>): Promise<T> {
  const history: ChatCompletionMessageParam[] = [{ role: "system", content: o.system }, ...o.messages];
  let useFormat = true;
  let lastError = "";
  for (let attempt = 0; attempt <= (o.retries ?? 2); attempt++) {
    let text: string;
    try {
      const res = await o.client.chat.completions.create({
        model: o.model,
        messages: history,
        max_tokens: o.maxTokens ?? 1200,
        ...(useFormat ? { response_format: { type: "json_object" as const } } : {}),
      });
      text = res.choices[0]?.message?.content ?? "";
    } catch (err) {
      if (useFormat && err instanceof OpenAI.APIError && err.status === 400) {
        useFormat = false;
        attempt--;
        continue;
      }
      throw err;
    }
    try {
      const parsed = o.schema.safeParse(parseJsonLoose(text));
      if (parsed.success) return parsed.data;
      lastError = z.prettifyError(parsed.error);
    } catch (err) {
      lastError = (err as Error).message;
    }
    history.push(
      { role: "assistant", content: text },
      { role: "user", content: `That reply was not valid: ${lastError}\nReply again with only the corrected JSON object.` },
    );
  }
  throw new Error(`The model did not return valid JSON: ${lastError}`);
}
