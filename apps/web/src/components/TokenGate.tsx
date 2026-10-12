"use client";
import { useEffect, useState, type ReactNode } from "react";
import { api, setToken } from "@/lib/api";

/** Reads #token= once, keeps it in localStorage, strips it from the address bar; otherwise asks for it. */
export function TokenGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "need" | "ok">("checking");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const verify = () =>
    api("/profile")
      .then(() => setState("ok"))
      .catch((e: Error) => {
        setError(e.message === "Unauthorized" ? "" : e.message);
        setState("need");
      });

  useEffect(() => {
    const m = location.hash.match(/token=([0-9a-f]{64})/i);
    if (m) {
      setToken(m[1]);
      history.replaceState(null, "", location.pathname + location.search);
    }
    void verify();
    const onUnauthorized = () => setState("need");
    window.addEventListener("aicaller-unauthorized", onUnauthorized);
    return () => window.removeEventListener("aicaller-unauthorized", onUnauthorized);
  }, []);

  if (state === "ok") return <>{children}</>;
  if (state === "checking") return <main className="muted">Connecting…</main>;
  return (
    <main>
      <div className="card stack" style={{ maxWidth: 520 }}>
        <h1>Dashboard token</h1>
        <p className="muted">
          Open the dashboard from the AI Caller window, or paste the dashboardToken from secrets.json in the AI Caller data folder.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setToken(value.trim());
            setState("checking");
            void verify();
          }}
        >
          <input type="password" aria-label="Dashboard token" value={value} onChange={(e) => setValue(e.target.value)} style={{ flex: 1 }} />
          <button type="submit" disabled={!value.trim()}>
            Continue
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
