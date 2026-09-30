// The colour of whoever wrote a comment. Yours is Agora's purple (`self`); anyone else's is one of AUTHOR_SLOTS
// colours picked from their id, so it is the same after a reload and on every page, and never purple.
// The colours are `--author-1…` in ./authors.css (light and dark, tuned to stay apart for colour-blind eyes: blue-greens,
// orange, pink and brown, not red against green). Agent answers keep the agent's mark; this is for people.
import { useMemo } from "react";
import { identity, isOwner, useThreads, type Message, type Thread, type ThreadStore } from "./threads";
import "./authors.css";

export const AUTHOR_SLOTS = 5;
export type AuthorSlot = "self" | 1 | 2 | 3 | 4 | 5;

// FNV-1a: cheap, stable everywhere, spreads short ids evenly.
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193);
  return h >>> 0;
};

/**
 * `by` is the author (absent on old comments: the owner's own), `viewer` who is looking, `viewerIsOwner` whether the
 * viewer is the project's owner (not a share guest): an old comment is the owner's, so to a guest it is somebody else's.
 */
export function authorSlot(by: { id: string } | undefined, viewer: { id: string } | undefined, viewerIsOwner: boolean): AuthorSlot {
  if (by ? by.id === viewer?.id : viewerIsOwner) return "self";
  return ((hash(by?.id ?? "owner") % AUTHOR_SLOTS) + 1) as AuthorSlot;
}

/**
 * Everyone who wrote on these threads, each with their colour: their own pick (`authorSlot`), or the next free one
 * when an author who came before them already has it, so two people on one canvas are never the same colour (up to
 * AUTHOR_SLOTS of them). "Before" is the time of a person's first comment, so a newcomer never changes anyone's colour.
 */
export function authorSlots(threads: readonly Pick<Thread, "messages">[], viewer: { id: string } | undefined, viewerIsOwner: boolean): Map<string, AuthorSlot> {
  const first = new Map<string, { at: number; by: Message["by"] }>();
  for (const t of threads)
    for (const m of t.messages) {
      if (m.deleted || m.author !== "you") continue;
      const key = m.by?.id ?? OWNER;
      if (!first.has(key) || m.at < first.get(key)!.at) first.set(key, { at: m.at, by: m.by });
    }
  const out = new Map<string, AuthorSlot>();
  const used = new Set<number>();
  for (const [key, { by }] of [...first].sort((a, b) => a[1].at - b[1].at || (a[0] < b[0] ? -1 : 1))) {
    let slot = authorSlot(by, viewer, viewerIsOwner);
    if (slot !== "self") {
      for (let k = 0; k < AUTHOR_SLOTS && used.has(slot as number); k++) slot = ((((slot as number) % AUTHOR_SLOTS) + 1) as AuthorSlot);
      if (!used.has(slot as number)) used.add(slot as number);
    }
    out.set(key, slot);
  }
  return out;
}

const OWNER = "owner";
const keyOf = (m: Pick<Message, "by">) => m.by?.id ?? OWNER;

/** The colours of the people on this canvas's comments, as the page shows them (recomputed as threads change). */
export function useAuthorColors(store: ThreadStore): { ofMessage: (m: Pick<Message, "by">) => AuthorSlot; ofThread: (t: Pick<Thread, "messages">) => AuthorSlot } {
  const { threads } = useThreads(store);
  const slots = useMemo(() => authorSlots(threads, identity(), isOwner()), [threads]);
  const ofMessage = (m: Pick<Message, "by">) => slots.get(keyOf(m)) ?? authorSlot(m.by, identity(), isOwner());
  return { ofMessage, ofThread: (t) => ofMessage(t.messages.find((m) => !m.deleted) ?? t.messages[0] ?? {}) };
}

/** Who to call the author of a thread: 你, their name, or (an old comment seen by someone else) the owner. */
export function threadAuthorName(t: Pick<Thread, "messages">): string {
  const m = t.messages.find((x) => !x.deleted) ?? t.messages[0];
  return authorSlot(m?.by, identity(), isOwner()) === "self" ? "你" : (m?.by?.name ?? "项目所有者");
}
