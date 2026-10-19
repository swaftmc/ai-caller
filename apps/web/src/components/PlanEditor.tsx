"use client";
import type { Autonomy, CallPlan, Mode } from "@ai-caller/shared";

const AUTONOMY: [Autonomy, string][] = [
  ["explain_only", "Explain only: shares no personal details, agrees to nothing"],
  ["approve_decisions", "Approve decisions: may read allowed details, asks you before agreeing to anything"],
  ["act_within_rules", "Act within rules: may agree only to what your numbered rules cover, otherwise asks you"],
];

/** Removes blank lines left over from editing the list fields. */
export function cleanPlan(p: CallPlan): CallPlan {
  const tidy = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  return { ...p, context: tidy(p.context), rules: tidy(p.rules) };
}

export function PlanEditor({
  plan,
  onChange,
  detailKeys,
}: {
  plan: CallPlan;
  onChange: (p: CallPlan) => void;
  detailKeys: string[];
}) {
  const set = <K extends keyof CallPlan>(k: K, v: CallPlan[K]) => onChange({ ...plan, [k]: v });
  const lines = (v: string) => v.split("\n");
  const toggleKey = (key: string, on: boolean) =>
    set("sharedDetailKeys", on ? [...new Set([...plan.sharedDetailKeys, key])] : plan.sharedDetailKeys.filter((k) => k !== key));

  return (
    <div className="stack">
      <div className="grid">
        <label>
          Company
          <input value={plan.company} onChange={(e) => set("company", e.target.value)} />
        </label>
        <label>
          Support number (E.164, e.g. +18005551234)
          <input value={plan.phoneNumber} onChange={(e) => set("phoneNumber", e.target.value.replace(/[^\d+]/g, ""))} />
          {plan.phoneNumberSource && <span className="muted">Source: {plan.phoneNumberSource}. Check it before you dial.</span>}
        </label>
      </div>
      <label>
        Issue
        <textarea value={plan.issue} onChange={(e) => set("issue", e.target.value)} />
      </label>
      <label>
        Desired outcome
        <textarea value={plan.desiredOutcome} onChange={(e) => set("desiredOutcome", e.target.value)} />
      </label>
      <label>
        Facts the AI may state (one per line)
        <textarea value={plan.context.join("\n")} onChange={(e) => set("context", lines(e.target.value))} />
      </label>

      <fieldset className="card">
        <legend>Mode</legend>
        {(
          [
            ["handoff", "Hand off: give me the call once a human answers"],
            ["resolve", "Resolve: the AI tries to fix it and brings me in only when needed"],
          ] as [Mode, string][]
        ).map(([m, text]) => (
          <label key={m} className="check">
            <input type="radio" name="mode" checked={plan.mode === m} onChange={() => set("mode", m)} />
            {text}
          </label>
        ))}
      </fieldset>

      <fieldset className="card">
        <legend>Autonomy</legend>
        {AUTONOMY.map(([a, text]) => (
          <label key={a} className="check">
            <input type="radio" name="autonomy" checked={plan.autonomy === a} onChange={() => set("autonomy", a)} />
            {text}
          </label>
        ))}
      </fieldset>

      {plan.autonomy === "act_within_rules" && (
        <label>
          Rules: what the AI may agree to (one per line, numbered in order)
          <textarea value={plan.rules.join("\n")} onChange={(e) => set("rules", lines(e.target.value))} />
        </label>
      )}

      <fieldset className="card">
        <legend>Stored details the AI may share</legend>
        {plan.autonomy === "explain_only" ? (
          <p className="muted">Explain-only calls share no details.</p>
        ) : detailKeys.length === 0 ? (
          <p className="muted">No stored details yet. Add them on the Profile page.</p>
        ) : (
          detailKeys.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={plan.sharedDetailKeys.includes(k)} onChange={(e) => toggleKey(k, e.target.checked)} />
              {k}
            </label>
          ))
        )}
      </fieldset>

      <div className="grid">
        <label className="check">
          <input type="checkbox" checked={plan.disclosure} onChange={(e) => set("disclosure", e.target.checked)} />
          Open with &ldquo;Hi, I&rsquo;m an AI assistant calling on behalf of …&rdquo;
        </label>
        <label>
          Give up after this many minutes on hold
          <input
            type="number"
            min={1}
            max={240}
            value={plan.maxHoldMinutes}
            onChange={(e) => set("maxHoldMinutes", Math.max(1, Math.min(240, Number(e.target.value) || 1)))}
          />
        </label>
      </div>
      <p className="muted">Whatever you choose, the AI always says it is an AI assistant if anyone asks, and never claims to be you.</p>
    </div>
  );
}
