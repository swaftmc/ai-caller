"use client";
import { useEffect, useState } from "react";
import type { Playbook } from "@ai-caller/shared";
import { api } from "@/lib/api";

export default function PlaybooksPage() {
  const [books, setBooks] = useState<Playbook[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Playbook[]>("/playbooks").then(setBooks, (e: Error) => setError(e.message));
  }, []);
  return (
    <>
      <h1>Playbooks</h1>
      <p className="muted">After each call the AI notes the menu paths and tactics that worked for that company, and uses them on the next call. No personal data is kept here.</p>
      {error && <p className="error">{error}</p>}
      {books?.length === 0 && <p className="muted">No playbooks yet.</p>}
      {books?.map((b) => (
        <div key={b.company} className="card">
          <h2>{b.company}</h2>
          {b.menuPaths.length > 0 && (
            <>
              <h3>Menu paths</h3>
              <ul>
                {b.menuPaths.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
          {b.tactics.length > 0 && (
            <>
              <h3>Tactics</h3>
              <ul>
                {b.tactics.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </>
          )}
          <p className="muted">Updated {new Date(b.updatedAt).toLocaleString()}</p>
        </div>
      ))}
    </>
  );
}
