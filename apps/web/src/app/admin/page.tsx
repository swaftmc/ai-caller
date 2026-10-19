"use client";
import { useCallback, useEffect, useState } from "react";
import type { AdminOverview } from "@ai-caller/shared";
import { useMe } from "@/components/AuthGate";
import { api } from "@/lib/api";

export default function AdminPage() {
  const me = useMe();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<AdminOverview>("/admin/overview").then(setData, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<string>) => {
    setError("");
    setMsg("");
    try {
      setMsg(await fn());
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!me?.isAdmin) return <p className="error">Admins only.</p>;
  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <>
      <h1>Admin</h1>
      <form
        className="card row"
        onSubmit={(e) => {
          e.preventDefault();
          const to = email.trim();
          void run(async () => {
            const r = await api<{ mailed: boolean }>("/admin/invites", "POST", { email: to });
            setEmail("");
            return r.mailed ? `Invited ${to}; they got an email.` : `Invited ${to}, but the email could not be sent. Tell them to sign in at this site.`;
          });
        }}
      >
        <input type="email" aria-label="Email to invite" placeholder="email to invite" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1 }} />
        <button type="submit" disabled={!email.trim()}>
          Invite
        </button>
      </form>

      {data.pendingInvites.length > 0 && (
        <div className="card">
          <h2>Invited, not signed in yet</h2>
          <table>
            <tbody>
              {data.pendingInvites.map((i) => (
                <tr key={i.email}>
                  <td>{i.email}</td>
                  <td className="muted">{new Date(i.createdAt).toLocaleDateString()}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="secondary" onClick={() => void run(async () => (await api(`/admin/invites/${encodeURIComponent(i.email)}`, "DELETE"), `Invite for ${i.email} removed.`))}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Users</h2>
        <table>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.email} {u.isAdmin && <span className="badge">admin</span>}
                </td>
                <td className="muted">{u.name}</td>
                <td className="muted">since {new Date(u.createdAt).toLocaleDateString()}</td>
                <td style={{ textAlign: "right" }}>
                  {u.id !== me.id && (
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm(`Remove ${u.email}? This deletes their calls, settings, keys and stored details, and they can no longer sign in.`))
                          void run(async () => (await api(`/admin/users/${u.id}`, "DELETE"), `${u.email} removed.`));
                      }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </>
  );
}
