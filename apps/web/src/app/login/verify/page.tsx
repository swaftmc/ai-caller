"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// The token is after "#", so it never reaches server logs or Referer headers.
// Signing in needs a click, so email link scanners that open the link cannot use it up.
export default function VerifyPage() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setToken(new URLSearchParams(location.hash.slice(1)).get("t") ?? "");
  }, []);

  const signIn = async () => {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      await api("/auth/verify", "POST", { token });
      history.replaceState(null, "", "/login/verify/");
      location.replace("/");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="card stack" style={{ maxWidth: 460, margin: "4rem auto" }}>
      <h1>Sign in to AI Caller</h1>
      {token === null ? (
        <p className="muted">Loading…</p>
      ) : !token ? (
        <p>
          This page needs the link from your sign-in email. <a href="/login/">Ask for a new link</a>.
        </p>
      ) : (
        <>
          <div>
            <button className="big" onClick={() => void signIn()} disabled={busy}>
              Sign in
            </button>
          </div>
          {error && (
            <p className="error">
              {error} <a href="/login/">Ask for a new link</a>.
            </p>
          )}
        </>
      )}
    </div>
  );
}
