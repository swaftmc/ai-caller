"use client";
import { useEffect, useRef, useState } from "react";
import type { BrowserAction, SettingsView, TurnResponse } from "@ai-caller/shared";
import { api } from "@/lib/api";
import { browserRecognitionSupported, playDtmf, speak, unlockAudio, vadRecognizer, webSpeechRecognizer, type Recognizer } from "@/lib/speech";
import { useEvents } from "@/lib/useEvents";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SpeakerphoneConsole({
  callId,
  phoneNumber,
  live,
  settings,
}: {
  callId: string;
  phoneNumber: string;
  live: boolean;
  settings: SettingsView;
}) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [keys, setKeys] = useState<string | null>(null);
  const [onHold, setOnHold] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const rec = useRef<Recognizer | null>(null);
  const active = useRef(false);
  const mutedRef = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const keysTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const stopListening = () => {
    active.current = false;
    rec.current?.stop();
    rec.current = null;
    setListening(false);
  };

  // Speak, then run actions in order; the mic is paused meanwhile and resumes 300 ms after.
  const perform = async (r: TurnResponse) => {
    if (!r.say && !r.actions.length) return;
    rec.current?.pause();
    try {
      if (r.say && !mutedRef.current) {
        setSpeaking(true);
        await speak(r.say, settings.serverTts);
      }
      for (const a of r.actions) await runAction(a);
    } finally {
      setSpeaking(false);
      if (active.current) {
        await sleep(300);
        if (active.current) rec.current?.resume();
      }
    }
  };

  const runAction = async (a: BrowserAction) => {
    if (a.type === "press_keys") {
      clearTimeout(keysTimer.current);
      setKeys(a.digits);
      keysTimer.current = setTimeout(() => setKeys(null), 12_000);
      await playDtmf(a.digits);
    } else if (a.type === "hold") setOnHold(a.on);
    else if (a.type === "hand_off") {
      stopListening();
      setOnHold(false);
      setNotice(`Your turn: take the phone off speaker and continue the call yourself. ${a.reason}`);
    } else if (a.type === "hang_up") {
      stopListening();
      setOnHold(false);
      setNotice(`The AI has finished: hang up your phone. ${a.reason}`);
    }
  };

  const enqueue = (r: TurnResponse) => {
    queue.current = queue.current.then(() => perform(r)).catch((e: Error) => setError(e.message));
  };

  const onText = (text: string) => {
    if (!active.current) return;
    api<TurnResponse>(`/calls/${callId}/local/heard`, "POST", { text })
      .then(enqueue)
      .catch((e: Error) => setError(e.message));
  };

  useEvents((e) => {
    if (e.type === "local_output" && e.callId === callId) enqueue(e);
  });

  useEffect(() => {
    if (!live) queue.current = queue.current.then(stopListening);
  }, [live]);
  useEffect(() => () => rec.current?.stop(), []);

  const start = async () => {
    setError("");
    unlockAudio();
    if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    if (!settings.serverStt && !browserRecognitionSupported()) {
      setError("This browser has no speech recognition. Use Chrome or Edge, or set up server speech recognition in Settings.");
      return;
    }
    const r = settings.serverStt ? vadRecognizer(onText, setError) : webSpeechRecognizer(onText, setError);
    try {
      await r.start();
      rec.current = r;
      active.current = true;
      setListening(true);
    } catch (e) {
      setError(`Could not start the microphone: ${(e as Error).message}`);
    }
  };

  const control = async (path: "takeover" | "end") => {
    try {
      const r = await api<{ actions: BrowserAction[] }>(`/calls/${callId}/${path}`, "POST", {});
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      enqueue({ say: "", actions: r.actions });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card stack">
      <h2>Speakerphone</h2>
      {live && !listening && !notice && (
        <ol>
          <li>
            Dial <strong>{phoneNumber}</strong> on your phone.
          </li>
          <li>Put the phone on speaker and place it next to this laptop.</li>
          <li>Press Start listening once the call connects.</li>
        </ol>
      )}
      <p className="banner">Stay quiet near the laptop: the AI hears everything in the room as the other side of the call.</p>
      {keys && (
        <div className="keys" role="status">
          Press {keys.split("").join(" ")} on your phone
        </div>
      )}
      {onHold && <p className="badge waiting">On hold. The AI is listening for a live person.</p>}
      {notice && <p className="card">{notice}</p>}
      {live && (
        <div className="row">
          {!listening ? (
            <button className="big" onClick={() => void start()}>
              Start listening
            </button>
          ) : (
            <span className="badge live">{speaking ? "AI speaking…" : "Listening"}</span>
          )}
          <button
            className="secondary"
            onClick={() => {
              mutedRef.current = !muted;
              setMuted(!muted);
              if (!muted && "speechSynthesis" in window) speechSynthesis.cancel();
            }}
          >
            {muted ? "Unmute AI" : "Mute AI"}
          </button>
          <button className="secondary" onClick={() => void control("takeover")}>
            I&rsquo;ll take over
          </button>
          <button className="danger" onClick={() => void control("end")}>
            End call
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
