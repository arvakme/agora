// What a figure's head shows for an agent (./figureNode.ts `mark`): the six CLIs' own marks — the same ones as everywhere else
// (app/agents/marks.tsx, drawn through session/AgentAvatar.tsx) — sized to the head; any other kind, its initial. Pure.
// Vector marks are <symbol>s (./RunAvatar.tsx `WorkerDefs`, ids from `symbolId`), Codex's and Grok's are their bundled images.
import { markFor } from "../session/agentMarks";

export type HeadMark =
  | { kind: "symbol"; id: string; x: number; y: number; w: number; h: number }
  | { kind: "image"; image: "codex" | "grok"; x: number; y: number; w: number; h: number }
  | { kind: "letter"; text: string; y: number; size: number };

/** The agents whose mark is a vector symbol in <WorkerDefs/>. */
export const SYMBOL_AGENTS = ["pi", "claude", "cursor", "devin"] as const;
export const symbolId = (agent: string) => `ws-m-${agent}`;

/** How wide each mark is drawn, in the head's `r` (the mark's own shape sets how much of it is ink: a badge or tile fills more of its box than a glyph). */
const SCALE = { pi: 1, claude: 1.4, codex: 1.44, grok: 1.3, cursor: 1.3, devin: 1.15 } as const;

/** The letters kinds that are not CLIs draw: a sub-agent known by its receipts, the person in the build replay (「你」 to the owner, 「作」 for the author to a guest). */
export const LETTERS: Record<string, string> = { worker: "W", you: "你", author: "作" };

/** The mark inside a head disc for a disc-sized `r`, centred on the origin. */
export function headMark(agent: string, r: number): HeadMark {
  const kind = markFor(agent);
  if (kind === "initial") return { kind: "letter", text: LETTERS[agent] ?? (agent[0] ?? "?").toUpperCase(), y: r * 0.36, size: r };
  const w = r * SCALE[kind];
  const box = { x: -w / 2, y: -w / 2, w, h: w };
  return kind === "codex" || kind === "grok" ? { kind: "image", image: kind, ...box } : { kind: "symbol", id: symbolId(kind), ...box };
}
