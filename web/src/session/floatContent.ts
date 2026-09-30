// How tall a floating session panel wants to be (web/docs/workstation.md §15): the panel's own parts (head, notices, composer) plus what the conversation
// takes when it is not scrolled. The shell is as tall as that up to the window; a conversation longer than the room scrolls as it always does.

/** The natural height (px) of a session pane's content, from its DOM; `Infinity` when it has no plain conversation (trajectory, the chooser): as tall as it may be. */
export function sessionContent(slot: HTMLElement): number {
  const stage = slot.querySelector<HTMLElement>(".sp-stage");
  const scroll = stage?.querySelector<HTMLElement>(".sp-scroll");
  if (!stage || !scroll) return Infinity;
  const px = (v: string) => parseFloat(v) || 0;
  const cs = getComputedStyle(scroll);
  let natural = px(cs.paddingTop) + px(cs.paddingBottom);
  for (const c of scroll.children) {
    const s = getComputedStyle(c);
    natural += (c as HTMLElement).offsetHeight + px(s.marginTop) + px(s.marginBottom);
  }
  return slot.clientHeight - stage.clientHeight + natural;
}
