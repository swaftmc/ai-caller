const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const TOKEN_KEY = "aicaller-token";

export const getToken = () => (typeof localStorage === "undefined" ? "" : localStorage.getItem(TOKEN_KEY) ?? "");
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function request(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${getToken()}`, ...(init.headers ?? {}) },
  });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event("aicaller-unauthorized"));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res;
}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await request(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export async function apiUpload<T>(path: string, blob: Blob): Promise<T> {
  const res = await request(path, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
  return (await res.json()) as T;
}

export async function apiBlob(path: string, body: unknown): Promise<Blob> {
  const res = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.blob();
}

export function wsUrl(): string {
  if (BASE) return `${BASE.replace(/^http/, "ws")}/ws`;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export const SETTINGS_CHANGED = "aicaller-settings-changed";
