import { createHmac } from "node:crypto";
import { safeEqual } from "../crypto.js";

export interface TwilioConfig {
  publicUrl: string;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  openaiKey: string;
  deepgramKey: string;
}

/** All six settings must be present, otherwise Twilio mode stays off. */
export function twilioConfig(env = process.env): TwilioConfig | null {
  const c = {
    publicUrl: env.PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "",
    accountSid: env.TWILIO_ACCOUNT_SID?.trim() ?? "",
    authToken: env.TWILIO_AUTH_TOKEN?.trim() ?? "",
    fromNumber: env.TWILIO_FROM_NUMBER?.trim() ?? "",
    openaiKey: env.OPENAI_API_KEY?.trim() ?? "",
    deepgramKey: env.DEEPGRAM_API_KEY?.trim() ?? "",
  };
  return Object.values(c).every(Boolean) && /^https:\/\//.test(c.publicUrl) ? c : null;
}

/** X-Twilio-Signature: base64 HMAC-SHA1 of the full URL plus sorted POST params (key+value). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validTwilioRequest(c: TwilioConfig, path: string, params: Record<string, string>, header: string | undefined): boolean {
  return Boolean(header) && safeEqual(twilioSignature(c.authToken, c.publicUrl + path, params), header!);
}

export const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function streamTwiml(c: TwilioConfig, callId: string, token: string, before = ""): string {
  const wss = `${c.publicUrl.replace(/^https:/, "wss:")}/twilio/media`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${before}<Connect><Stream url="${xml(wss)}"><Parameter name="callId" value="${xml(callId)}"/><Parameter name="token" value="${xml(token)}"/></Stream></Connect></Response>`;
}

export const conferenceTwiml = (name: string, say = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${say ? `<Say>${xml(say)}</Say>` : ""}<Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true">${xml(name)}</Conference></Dial></Response>`;

/** Minimal Twilio REST client (form-encoded, basic auth). */
export async function twilioApi(c: TwilioConfig, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${String(body.message ?? res.statusText)}`);
  return body;
}
