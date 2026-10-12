"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { CallRecord } from "@ai-caller/shared";
import { StatusBadge } from "@/components/Shell";
import { api } from "@/lib/api";
import { useEvents } from "@/lib/useEvents";

export default function CallsPage() {
  const [calls, setCalls] = useState<CallRecord[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<CallRecord[]>("/calls")
      .then(setCalls)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEvents((e) => {
    if (e.type === "ready") load();
    if (e.type === "status") setCalls((cs) => cs?.map((c) => (c.id === e.callId ? { ...c, status: e.status } : c)) ?? cs);
  });

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>Calls</h1>
        <Link href="/new/" className="button">
          New call
        </Link>
      </div>
      {error && <p className="error">{error}</p>}
      {calls && calls.length === 0 && <p className="muted">No calls yet.</p>}
      {calls && calls.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Issue</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/call/?id=${c.id}`}>{c.plan.company}</Link>
                  </td>
                  <td>{c.plan.issue}</td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="muted">{new Date(c.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
