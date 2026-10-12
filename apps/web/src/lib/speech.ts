"use client";
import { apiBlob, apiUpload } from "./api";

export interface Recognizer {
  start(): Promise<void>;
  /** Stops hearing (while the AI speaks); resume() starts again. */
  pause(): void;
  resume(): void;
  stop(): void;
}
type OnText = (text: string) => void;
type OnError = (message: string) => void;

// ---- Web Speech API (Chrome/Edge) ----

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionCtor = new () => SpeechRecognitionLike;

export function browserRecognitionSupported(): boolean {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

/** Continuous Web Speech recognition, final results only, restarted whenever the browser ends it. */
export function webSpeechRecognizer(onText: OnText, onError: OnError): Recognizer {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  let rec: SpeechRecognitionLike | null = null;
  let wanted = false;
  const begin = () => {
    if (!Ctor || !wanted) return;
    const r = new Ctor();
    rec = r;
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || "en-US";
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (res.isFinal && text) onText(text);
      }
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wanted = false;
        onError("Microphone access was blocked. Allow the microphone for this page and press Start listening again.");
      }
    };
    r.onend = () => {
      if (rec === r && wanted) setTimeout(begin, 250);
    };
    try {
      r.start();
    } catch {
      setTimeout(begin, 500);
    }
  };
  const halt = () => {
    const r = rec;
    rec = null;
    r?.abort();
  };
  return {
    async start() {
      if (!Ctor) throw new Error("This browser has no speech recognition. Use Chrome or Edge, or set up server speech recognition in Settings.");
      wanted = true;
      begin();
    },
    pause() {
      wanted = false;
      halt();
    },
    resume() {
      if (wanted) return;
      wanted = true;
      begin();
    },
    stop() {
      wanted = false;
      halt();
    },
  };
}

// ---- Own voice-activity detection + server transcription ----

const WORKLET = `class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
    return true;
  }
}
registerProcessor("tap", Tap);`;

const SILENCE_MS = 800;
const MIN_SPEECH_MS = 350;
const MAX_UTTERANCE_MS = 15_000;
const PREROLL_MS = 300;

/** Microphone VAD that uploads each utterance as 16 kHz mono WAV to /api/speech/transcribe. */
export function vadRecognizer(onText: OnText, onError: OnError): Recognizer {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let paused = false;
  let noise = 0;
  let inSpeech = false;
  let chunks: Float32Array[] = [];
  let preroll: Float32Array[] = [];
  let speechMs = 0;
  let silenceMs = 0;
  let totalMs = 0;
  const reset = () => {
    inSpeech = false;
    chunks = [];
    speechMs = silenceMs = totalMs = 0;
  };

  const finish = () => {
    const parts = chunks;
    const enough = speechMs >= MIN_SPEECH_MS;
    reset();
    if (!enough || !ctx) return;
    const wav = encodeWav(parts, ctx.sampleRate);
    apiUpload<{ text: string }>("/speech/transcribe", wav)
      .then((r) => r.text && onText(r.text))
      .catch((e: Error) => onError(`Transcription failed: ${e.message}`));
  };

  const onChunk = (chunk: Float32Array) => {
    if (paused || !ctx) return;
    const ms = (chunk.length / ctx.sampleRate) * 1000;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    // Adaptive noise floor: falls quickly to quiet levels, rises slowly with steady background noise.
    noise = noise === 0 ? rms : rms < noise ? noise * 0.9 + rms * 0.1 : noise * 0.995 + rms * 0.005;
    const loud = rms > Math.max(noise * 3, 0.008);
    if (!inSpeech) {
      preroll.push(chunk);
      let preMs = preroll.reduce((a, c) => a + (c.length / ctx!.sampleRate) * 1000, 0);
      while (preMs > PREROLL_MS && preroll.length > 1) preMs -= (preroll.shift()!.length / ctx.sampleRate) * 1000;
      if (!loud) return;
      inSpeech = true;
      chunks = preroll.slice(0, -1);
      preroll = [];
    }
    chunks.push(chunk);
    totalMs += ms;
    if (loud) {
      speechMs += ms;
      silenceMs = 0;
    } else silenceMs += ms;
    if (silenceMs >= SILENCE_MS || totalMs >= MAX_UTTERANCE_MS) finish();
  };

  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, "tap");
      node.port.onmessage = (e) => onChunk(e.data as Float32Array);
      ctx.createMediaStreamSource(stream).connect(node);
      paused = false;
    },
    pause() {
      paused = true;
      reset();
      preroll = [];
    },
    resume() {
      paused = false;
    },
    stop() {
      paused = true;
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      ctx = null;
      stream = null;
    },
  };
}

/** Downsamples float chunks to 16 kHz and encodes 16-bit PCM mono WAV. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const input = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    input.set(c, off);
    off += c.length;
  }
  const ratio = sampleRate / 16000;
  const outLen = Math.floor(total / ratio);
  const view = new DataView(new ArrayBuffer(44 + outLen * 2));
  const text = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + outLen * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let acc = 0;
    for (let j = start; j < end && j < total; j++) acc += input[j];
    const v = Math.max(-1, Math.min(1, acc / (end - start)));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

// ---- Speaking ----

function speakSentence(text: string): Promise<void> {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language || "en-US";
    // Some browsers never fire onend; fall back to a length-based timeout.
    const timer = setTimeout(resolve, 3000 + text.length * 90);
    u.onend = u.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    speechSynthesis.speak(u);
  });
}

async function speakBrowser(text: string) {
  if (!("speechSynthesis" in window)) return;
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  for (const s of sentences) if (s.trim()) await speakSentence(s.trim());
}

/** Speaks text with server TTS when enabled, falling back to the browser voice on any failure. */
export async function speak(text: string, useServer: boolean): Promise<void> {
  if (!text.trim()) return;
  if (useServer) {
    try {
      const blob = await apiBlob("/speech/synthesize", { text });
      const url = URL.createObjectURL(blob);
      try {
        const audio = new Audio(url);
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error("playback failed"));
          audio.play().catch(reject);
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      return;
    } catch {
      // fall through to the browser voice
    }
  }
  await speakBrowser(text);
}

// ---- DTMF tones ----

const DTMF: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};
let toneCtx: AudioContext | null = null;

/** Call from a click handler so later tones are allowed to play. */
export function unlockAudio() {
  toneCtx ??= new AudioContext();
  void toneCtx.resume();
}

/** Plays each key as two sines: 250 ms tone, 150 ms gap. */
export async function playDtmf(digits: string): Promise<void> {
  unlockAudio();
  const ctx = toneCtx!;
  let t = ctx.currentTime + 0.05;
  for (const d of digits) {
    const pair = DTMF[d];
    if (!pair) continue;
    const gain = ctx.createGain();
    gain.gain.value = 0.25;
    gain.connect(ctx.destination);
    for (const f of pair) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + 0.25);
    }
    t += 0.4;
  }
  await new Promise((r) => setTimeout(r, (t - ctx.currentTime) * 1000));
}
