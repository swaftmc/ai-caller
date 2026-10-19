// Same-origin API calls; the session cookie is sent by the browser.
async function request(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`/api${path}`, init);
  if (res.status === 401) window.dispatchEvent(new Event("aicaller-unauthorized"));
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

export const wsUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export const SETTINGS_CHANGED = "aicaller-settings-changed";
