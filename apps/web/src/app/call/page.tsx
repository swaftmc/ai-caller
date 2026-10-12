"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  CallPlanSchema,
  LIVE_STATUSES,
  type AccountDetailView,
  type Approval,
  type CallPlan,
  type CallRecord,
  type SettingsView,
  type TranscriptEntry,
} from "@ai-caller/shared";
import { ApprovalCard, OutcomeCard, TellTheAi, Transcript } from "@/components/CallParts";
import { PlanEditor, cleanPlan } from "@/components/PlanEditor";
import { StatusBadge } from "@/components/Shell";
import { SpeakerphoneConsole } from "@/components/SpeakerphoneConsole";
import { api } from "@/lib/api";
import { useEvents } from "@/lib/useEvents";

interface CallData {
  call: CallRecord;
  transcript: TranscriptEntry[];
  approvals: Approval[];
  live: boolean;
}

export default function CallPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <CallView />
    </Suspense>
  );
}

function CallView() {
  const id = useSearchParams().get("id") ?? "";
  const [data, setData] = useState<CallData | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [detailKeys, setDetailKeys] = useState<string[]>([]);
  const [draft, setDraft] = useState<CallPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api<CallData>(`/calls/${id}`)
      .then((d) => {
        setData(d);
        setDraft((p) => p ?? (d.call.status === "draft" ? d.call.plan : null));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(() => {
    load();
    api<SettingsView>("/settings").then(setSettings, () => undefined);
    api<{ details: AccountDetailView[] }>("/profile").then((p) => setDetailKeys(p.details.map((d) => d.key)), () => undefined);
  }, [load]);

  useEvents((e) => {
    if (e.type === "ready") return load();
    if (e.callId !== id) return;
    setData((d) => {
      if (!d) return d;
      switch (e.type) {
        case "status":
          return { ...d, call: { ...d.call, status: e.status }, live: d.live && LIVE_STATUSES.includes(e.status) };
        case "transcript":
          return d.transcript.some((t) => t.id === e.entry.id) ? d : { ...d, transcript: [...d.transcript, e.entry] };
        case "approval":
          return { ...d, approvals: [...d.approvals.filter((a) => a.id !== e.approval.id), e.approval] };
        case "outcome":
          return { ...d, call: { ...d.call, outcome: e.outcome } };
        default:
          return d;
      }
    });
  });

  const start = async () => {
    if (!draft) return;
    const parsed = CallPlanSchema.safeParse(cleanPlan(draft));
    if (!parsed.success) return setError(z.prettifyError(parsed.error));
    setBusy(true);
    setError("");
    try {
      await api(`/calls/${id}/plan`, "PUT", { plan: parsed.data });
      await api(`/calls/${id}/start`, "POST", {});
      setDraft(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!id) return <p className="error">No call id in the address.</p>;
  if (!data || !settings) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const { call } = data;
  const pending = data.approvals.filter((a) => a.status === "pending");
  const resolved = data.approvals.filter((a) => a.status !== "pending");

  return (
    <>
      <div className="row" style={{ marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>{call.plan.company}</h1>
        <StatusBadge status={call.status} />
        <span className="muted">{call.plan.phoneNumber}</span>
      </div>
      <p className="muted">
        {call.plan.issue} → {call.plan.desiredOutcome}
      </p>

      {call.status === "draft" && draft && (
        <div className="card">
          <h2>Review the plan</h2>
          <PlanEditor plan={draft} onChange={setDraft} detailKeys={detailKeys} twilioEnabled={settings.twilioEnabled} />
          <div className="row" style={{ marginTop: "1rem" }}>
            <button className="big" onClick={() => void start()} disabled={busy}>
              Start call
            </button>
          </div>
        </div>
      )}

      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}

      {call.plan.channel === "speakerphone" && call.status !== "draft" && (
        <SpeakerphoneConsole callId={call.id} phoneNumber={call.plan.phoneNumber} live={data.live} settings={settings} />
      )}
      {call.plan.channel === "twilio" && data.live && (
        <div className="card row">
          <span className="muted">The server is on the phone call.</span>
          <button onClick={() => api(`/calls/${call.id}/takeover`, "POST", {}).catch((e: Error) => setError(e.message))}>Join (ring my phone)</button>
          <button className="danger" onClick={() => api(`/calls/${call.id}/end`, "POST", {}).catch((e: Error) => setError(e.message))}>
            End call
          </button>
        </div>
      )}
      {data.live && <TellTheAi callId={call.id} />}
      {call.outcome && <OutcomeCard outcome={call.outcome} />}
      {resolved.length > 0 && (
        <div className="card">
          <h2>Approval requests</h2>
          {resolved.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      )}
      {call.status !== "draft" && <Transcript entries={data.transcript} />}
      {error && <pre className="error">{error}</pre>}
    </>
  );
}
