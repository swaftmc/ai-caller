import { E164 } from "@ai-caller/shared";

const EMERGENCY = new Set(["911", "112", "999", "000", "110", "119"]);

/** Returns an error message, or null if the server may dial this number. Country codes default to "1" (US/Canada). */
export function dialableError(number: string, allowed = (process.env.DIAL_ALLOWED_COUNTRY_CODES ?? "1").split(",").map((c) => c.trim()).filter(Boolean)): string | null {
  if (!E164.test(number)) return "Number must be E.164, e.g. +18005551234";
  const digits = number.slice(1);
  const cc = allowed.find((c) => digits.startsWith(c));
  if (!cc) return `Country code not allowed (allowed: ${allowed.map((c) => `+${c}`).join(", ")})`;
  const national = digits.slice(cc.length);
  if (EMERGENCY.has(national) || national.length <= 3) return "Emergency and short service numbers cannot be dialed";
  if (cc === "1") {
    if (national.length !== 10) return "US/Canada numbers have 10 digits after +1";
    const area = national.slice(0, 3);
    const exchange = national.slice(3, 6);
    if (/^[2-9]11$/.test(area) || /^[2-9]11$/.test(exchange)) return "N11 service numbers (211-911) cannot be dialed";
    if (area === "900" || area === "976" || exchange === "976") return "Premium-rate 900/976 numbers are blocked";
    if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exchange)) return "Not a valid US/Canada number";
  }
  return null;
}
