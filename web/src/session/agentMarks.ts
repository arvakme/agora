// Which mark an agent kind is drawn with (session/AgentAvatar.tsx). The six CLIs Agora knows have their own; any other kind
// (a CLI added later, a worker known only by its receipts) falls back to its initial. Pure.
export type MarkKind = "pi" | "claude" | "codex" | "grok" | "cursor" | "devin" | "initial";

const OWN = new Set<string>(["pi", "claude", "codex", "grok", "cursor", "devin"]);

export const markFor = (kind: string): MarkKind => (OWN.has(kind) ? (kind as MarkKind) : "initial");
export const hasOwnMark = (kind: string) => OWN.has(kind);
