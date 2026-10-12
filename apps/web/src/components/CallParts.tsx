"use client";
import { useEffect, useRef, useState } from "react";
import type { Approval, CallOutcome, TranscriptEntry } from "@ai-caller/shared";
import { api } from "@/lib/api";

const WHO: Record<TranscriptEntry["speaker"], string> = { them: "Them", ai: "AI", system: "System", user: "You" };

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [entries.length]);
  return (
    <div className="card">
      <h2>Transcript</h2>
      <div className="transcript" aria-live="polite">
        {entries.map((e) => (
          <div key={e.id} className={`line ${e.speaker}`}>
            <span className="who">
              {WHO[e.speaker]} · {new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <span>{e.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError("");
    try {
      await api(`/approvals/${approval.id}`, "POST", { decision, note: note.trim() || undefined });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (approval.status !== "pending") {
    return (
      <p className="muted">
        Request {approval.id}: {approval.question} <span className="badge">{approval.status}</span>
        {approval.note ? ` (${approval.note})` : ""}
      </p>
    );
  }
  return (
    <div className="card approval stack" role="alert">
      <h3>The AI needs your approval</h3>
      <p>{approval.question}</p>
      {approval.options.length > 0 && <p className="muted">Options mentioned: {approval.options.join(" / ")}</p>}
      <label>
        Note for the AI (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </label>
      <div className="row">
        <button onClick={() => void decide("approve")} disabled={busy}>
          Approve
        </button>
        <button className="danger" onClick={() => void decide("deny")} disabled={busy}>
          Deny
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function OutcomeCard({ outcome }: { outcome: CallOutcome }) {
  return (
    <div className="card stack">
      <h2>Outcome {outcome.result && <span className="badge good">{outcome.result.replace("_", " ")}</span>}</h2>
      <p>{outcome.summary || "No summary."}</p>
      {outcome.referenceNumbers.length > 0 && (
        <div>
          <h3>Reference numbers</h3>
          <ul>
            {outcome.referenceNumbers.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {outcome.followUps.length > 0 && (
        <div>
          <h3>Next steps</h3>
          <ul>
            {outcome.followUps.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function TellTheAi({ callId }: { callId: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="card row"
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        setText("");
        api(`/calls/${callId}/instruct`, "POST", { text: t }).catch((err: Error) => setError(err.message));
      }}
    >
      <input aria-label="Tell the AI" placeholder="Tell the AI… (e.g. ask for a supervisor)" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
      <button type="submit" disabled={!text.trim()}>
        Send
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
