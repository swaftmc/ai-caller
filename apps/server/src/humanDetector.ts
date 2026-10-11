import { z } from "zod";

const RECORDED = [
  "your call is important",
  "please continue to hold",
  "please stay on the line",
  "calls may be recorded",
  "call may be recorded",
  "may be monitored or recorded",
  "estimated wait time",
  "all of our agents are",
  "all of our representatives are",
  "currently assisting other",
  "in the order it was received",
  "thank you for your patience",
  "visit our website",
  "next available",
  "high call volume",
  "higher than normal call volume",
  "you are caller number",
  "minutes remaining",
];
const LIVE = [
  "my name is",
  "how can i help",
  "how may i help",
  "how can i assist",
  "how may i assist",
  "what can i do for you",
  "are you still there",
  "is anyone there",
  "who am i speaking with",
  "who do i have the pleasure",
  "can i get your name",
  "may i have your name",
  "can you hear me",
  "hello hello",
  "thanks for holding",
  "thank you for holding",
  "sorry for the wait",
  "sorry to keep you waiting",
];

const ClassifierSchema = z.object({ live_human: z.boolean(), confidence: z.number().min(0).max(1) });
export type Classifier = (text: string) => Promise<z.infer<typeof ClassifierSchema>>;
export { ClassifierSchema };

export const normalize = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export interface Verdict {
  human: boolean;
  reason: "empty" | "repeat" | "recorded" | "live_phrase" | "classifier" | "classifier_error";
}

/** Decides whether an utterance heard on hold came from a live person. */
export class HumanDetector {
  // ponytail: repeats are exact matches after normalization; a fuzzy match would catch recordings that STT hears slightly differently.
  private heard = new Set<string>();

  constructor(private classify: Classifier) {}

  reset() {
    this.heard.clear();
  }

  async check(text: string): Promise<Verdict> {
    const t = normalize(text);
    if (!t) return { human: false, reason: "empty" };
    if (this.heard.has(t)) return { human: false, reason: "repeat" };
    this.heard.add(t);
    if (RECORDED.some((p) => t.includes(p))) return { human: false, reason: "recorded" };
    if (LIVE.some((p) => t.includes(p))) return { human: true, reason: "live_phrase" };
    try {
      const r = await this.classify(text);
      return { human: r.live_human && r.confidence >= 0.7, reason: "classifier" };
    } catch {
      return { human: false, reason: "classifier_error" };
    }
  }
}
