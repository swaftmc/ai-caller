"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  CallPlanSchema,
  type AccountDetailView,
  type CallPlan,
  type CallRecord,
  type ChatMessage,
  type IntakeReply,
} from "@ai-caller/shared";
import { PlanEditor, cleanPlan } from "@/components/PlanEditor";
import { api } from "@/lib/api";

export default function NewCallPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<CallPlan | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [detailKeys, setDetailKeys] = useState<string[]>([]);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ details: AccountDetailView[] }>("/profile").then((p) => setDetailKeys(p.details.map((d) => d.key)), () => undefined);
  }, []);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError("");
    try {
      const r = await api<IntakeReply>("/intake", "POST", { messages: next });
      setMessages([...next, { role: "assistant", content: r.reply }]);
      if (r.plan) setPlan(r.plan);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!plan) return;
    const parsed = CallPlanSchema.safeParse(cleanPlan(plan));
    if (!parsed.success) return setError(z.prettifyError(parsed.error));
    setBusy(true);
    setError("");
    try {
      let id = draftId;
      if (id) await api(`/calls/${id}/plan`, "PUT", { plan: parsed.data });
      else {
        id = (await api<CallRecord>("/calls", "POST", { plan: parsed.data })).id;
        setDraftId(id);
      }
      await api(`/calls/${id}/start`, "POST", {});
      router.push(`/call/?id=${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <h1>New call</h1>
      <div className="card">
        <p className="muted">
          Describe the problem in your own words: which company, what went wrong, what you want. Do not type account numbers or passwords here; add
          them on the Profile page.
        </p>
        <div className="chat">
          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy && !plan && <div className="bubble assistant muted">Thinking…</div>}
          <div ref={chatEnd} />
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            aria-label="Message"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={messages.length ? "Reply…" : "e.g. Acme Bank charged me twice for one order and I want a refund"}
            style={{ flex: 1 }}
          />
          <button type="submit" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
      </div>

      {plan && (
        <div className="card">
          <h2>Review the plan</h2>
          <PlanEditor plan={plan} onChange={setPlan} detailKeys={detailKeys} />
          <div className="row" style={{ marginTop: "1rem" }}>
            <button className="big" onClick={() => void start()} disabled={busy}>
              Start call
            </button>
          </div>
        </div>
      )}
      {error && <pre className="error">{error}</pre>}
    </>
  );
}
