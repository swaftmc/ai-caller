"use client";
import { useEffect, useState } from "react";
import type { AccountDetailView, Profile } from "@ai-caller/shared";
import { api } from "@/lib/api";

interface ProfileData {
  profile: Profile;
  details: AccountDetailView[];
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [details, setDetails] = useState<AccountDetailView[]>([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<ProfileData>("/profile").then(
      (d) => {
        setProfile(d.profile);
        setDetails(d.details);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setError("");
    setMsg("");
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!profile) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <>
      <h1>Profile</h1>
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => setProfile((await api<ProfileData>("/profile", "PUT", profile)).profile), "Profile saved.");
        }}
      >
        <div className="grid">
          <label>
            Your name (the AI says it calls on your behalf)
            <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
          </label>
          <label>
            Callback phone, optional (E.164)
            <input value={profile.callbackPhone} onChange={(e) => setProfile({ ...profile, callbackPhone: e.target.value.replace(/[^\d+]/g, "") })} />
          </label>
        </div>
        <div>
          <button type="submit">Save</button>
        </div>
      </form>

      <div className="card stack">
        <h2>Stored details</h2>
        <p className="muted">
          Encrypted on this computer. A call can read only the details you tick in its plan, and every read is logged. The AI never sees them in its
          instructions.
        </p>
        {details.length > 0 && (
          <table>
            <tbody>
              {details.map((d) => (
                <tr key={d.key}>
                  <td>{d.key}</td>
                  <td>{d.masked}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="secondary"
                      onClick={() =>
                        void run(async () => setDetails((await api<{ details: AccountDetailView[] }>(`/profile/details/${encodeURIComponent(d.key)}`, "DELETE")).details), "Deleted.")
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setDetails((await api<{ details: AccountDetailView[] }>("/profile/details", "POST", { key: key.trim(), value })).details);
              setKey("");
              setValue("");
            }, "Detail saved.");
          }}
        >
          <input aria-label="Detail name" placeholder="name, e.g. account_number" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} style={{ flex: 1 }} />
          <input aria-label="Detail value" type="password" placeholder="value" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} style={{ flex: 1 }} />
          <button type="submit" disabled={!key.trim() || !value}>
            Add
          </button>
        </form>
      </div>
      <div className="card stack">
        <h2>Delete my account</h2>
        <p className="muted">Deletes your calls, transcripts, playbooks, settings, API keys and stored details from this server. It cannot be undone.</p>
        <div>
          <button
            className="danger"
            onClick={() => {
              if (!confirm("Delete your AI Caller account and everything in it? This cannot be undone.")) return;
              void run(async () => {
                await api("/me", "DELETE");
                location.replace("/login/");
              }, "Account deleted.");
            }}
          >
            Delete my account
          </button>
        </div>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {error && <pre className="error">{error}</pre>}
    </>
  );
}
