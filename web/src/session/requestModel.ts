// What a two-way CLI asks the person (server/canvas/sessions.py `public_request`) and the rules for the
// cards that answer it, plus how the page says who holds a terminal session's input. Pure.
import type { Status } from "./agents";

export type Question = { question: string; header?: string | null; multiSelect: boolean; options: { label: string; description: string }[] };
export type HostRequest = {
  id: string;
  sessionId: string;
  kind: "question" | "approval";
  tool: string;
  toolUseId?: string;
  at: number;
  questions?: Question[];
  summary?: string;
  reason?: string | null;
  /** The CLI offered "allow for the rest of this session". */
  canSession?: boolean;
  input?: Record<string, unknown>;
};
export type Decision = { decision: "allow" | "allow_session" | "deny"; message?: string; answers?: Record<string, string | string[]> };
/** question text → the labels picked */
export type Picks = Record<string, string[]>;

export function pick(q: Question, picks: Picks, label: string): Picks {
  const cur = picks[q.question] ?? [];
  const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
  return { ...picks, [q.question]: next };
}

export const answered = (r: HostRequest, picks: Picks) => (r.questions ?? []).every((q) => (picks[q.question] ?? []).length > 0);

export function answerBody(r: HostRequest, picks: Picks): Decision {
  const answers: Record<string, string | string[]> = {};
  for (const q of r.questions ?? []) answers[q.question] = q.multiSelect ? picks[q.question] : picks[q.question][0];
  return { decision: "allow", answers };
}

export function upsertRequest(list: readonly HostRequest[], r: HostRequest): HostRequest[] {
  const i = list.findIndex((x) => x.id === r.id);
  return i < 0 ? [...list, r] : list.map((x, j) => (j === i ? r : x));
}
export const removeRequest = (list: HostRequest[], id: string) => (list.some((x) => x.id === id) ? list.filter((x) => x.id !== id) : list);

/** The permission mode the CLI really runs in: auto, or — a model without auto — what it fell back to. */
export function modeLabel(mode: { actual: string | null; asked: string } | null | undefined): { text: string; tone: "ok" | "caution" } | null {
  if (!mode?.actual) return null;
  return mode.actual === mode.asked ? { text: mode.actual, tone: "ok" } : { text: `${mode.actual}（这个模型不支持 ${mode.asked}）`, tone: "caution" };
}

type Term = Status["terminal"];
/** A terminal window (or a takeover) holds the input: only then is the session "taken over". Without a window the CLI in the pane is only finishing in the background. */
export function terminalBanner(t: Term | undefined): "attached" | "background" | null {
  if (!t?.alive) return null;
  return t.clients > 0 || t.inputRight === "human" ? "attached" : "background";
}

export type InputRightNote = { text: string; by: "window" | "takeover"; canSendNow: boolean; canTakeOver: boolean; takenOver: boolean };
/** Messages wait because a person holds the pane's input: say who, and offer "send now" and take over / give back. */
export function inputRightNote(s: Pick<Status, "queued" | "held" | "terminal">): InputRightNote | null {
  const t = s.terminal;
  if (!t?.alive || s.queued < 1) return null;
  if (t.inputRight === "human") return { text: "终端已被你接管 · 你的话在排队", by: "takeover", canSendNow: true, canTakeOver: true, takenOver: true };
  if ((t.writers ?? 0) > 0 || t.paused) return { text: "终端窗口开着 · 你的话在排队", by: "window", canSendNow: true, canTakeOver: true, takenOver: false };
  return null;
}
