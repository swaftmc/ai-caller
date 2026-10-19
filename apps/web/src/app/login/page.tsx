"use client";
import { useState } from "react";
import { api } from "@/lib/api";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/auth/request", "POST", { email: email.trim() });
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack" style={{ maxWidth: 460, margin: "4rem auto" }}>
      <h1>AI Caller</h1>
      {sent ? (
        <>
          <p>If {email.trim()} has been invited, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
          <p className="muted">Nothing arrived? Check your spam folder, or ask whoever invited you.</p>
          <div>
            <button className="secondary" onClick={() => setSent(false)}>
              Use a different email
            </button>
          </div>
        </>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="muted">AI Caller is invite-only. Enter the email address you were invited with and we&rsquo;ll send you a sign-in link.</p>
          <label>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <div>
            <button type="submit" disabled={busy || !email.trim()}>
              Send sign-in link
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      )}
    </div>
  );
}
