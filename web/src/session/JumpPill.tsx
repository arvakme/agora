// 「回到最新」: a small pill above the composer while the pane is scrolled off the end (./jumpToBottom.ts decides).
// Scrolled up, nothing scrolls by itself; at the end, new content stays in view. Click, or End with the focus in the
// pane (not in a text box), scrolls to the end — smoothly, or at once with reduced motion.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { jumpLabel, observe, type Metrics, type Track } from "./jumpToBottom";

const metrics = (el: HTMLElement): Metrics => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight });
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/**
 * `count`: how many items the pane holds (what "new" is counted in); `paused`: something else is placing the scroll
 * (a step being focused), so do not follow. Returns what the pill shows and how to jump.
 */
export function useJumpToBottom(el: RefObject<HTMLElement | null>, count: number, paused = false, remount: unknown = null) {
  const [seen, setSeen] = useState({ unread: 0, show: false });
  const track = useRef<Track>({ base: null });
  const follow = useRef(true);
  const countRef = useRef(count);
  countRef.current = count;
  const jumping = useRef(false);
  const lastTop = useRef(0);

  const look = useCallback(() => {
    const e = el.current;
    if (!e) return;
    // a smooth jump passes through "away" on its way: not the person leaving
    if (jumping.current) {
      if (observe(track.current, metrics(e), countRef.current).follow) jumping.current = false;
      else return;
    }
    const r = observe(track.current, metrics(e), countRef.current);
    lastTop.current = e.scrollTop;
    track.current = r.track;
    follow.current = r.follow;
    setSeen((s) => (s.unread === r.unread && s.show === r.show ? s : { unread: r.unread, show: r.show }));
  }, [el]);

  // the person scrolls (or the pane is resized)
  useEffect(() => {
    const e = el.current;
    if (!e) return;
    e.addEventListener("scroll", look, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(look) : null;
    ro?.observe(e);
    look();
    return () => (e.removeEventListener("scroll", look), ro?.disconnect());
  }, [el, look, remount]);

  // content grows (also text streaming into an item, which changes no count): at the end, stay at the end
  useEffect(() => {
    const e = el.current;
    if (!e || typeof MutationObserver !== "function") return;
    const mo = new MutationObserver(() => {
      // scrolled up since the last look (its scroll event has not run yet): that is leaving the end, not being at it
      if (e.scrollTop < lastTop.current - 2 && !jumping.current) look();
      if (follow.current && !paused && !jumping.current) e.scrollTop = e.scrollHeight;
      requestAnimationFrame(look);
    });
    mo.observe(e, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [el, look, paused, remount]);

  // opening the pane (or switching back to it) lands on the newest; after that a new item is followed, or counted
  const primed = useRef<unknown>(undefined);
  useEffect(() => {
    const e = el.current;
    const first = primed.current !== remount;
    if (e && !paused && (first || follow.current)) {
      e.scrollTop = e.scrollHeight;
      follow.current = true;
      track.current = { base: null };
      if (first) primed.current = remount;
    }
    look();
  }, [count, paused, el, look, remount]);

  const jump = useCallback(() => {
    const e = el.current;
    if (!e) return;
    jumping.current = !reduced();
    track.current = { base: null };
    follow.current = true;
    setSeen({ unread: 0, show: false });
    e.scrollTo({ top: e.scrollHeight, behavior: reduced() ? "auto" : "smooth" });
    if (jumping.current) setTimeout(() => ((jumping.current = false), look()), 1500); // never stay "jumping" if the content grew on the way
  }, [el, look]);

  // End with the focus in the pane (not typing in a box): the same as the pill
  useEffect(() => {
    const root = el.current?.closest<HTMLElement>(".sp");
    if (!root) return;
    const on = (ev: KeyboardEvent) => {
      if (ev.key === "End" && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !editable(ev.target)) (ev.preventDefault(), jump());
    };
    root.addEventListener("keydown", on);
    return () => root.removeEventListener("keydown", on);
  }, [el, jump]);

  return { ...seen, jump };
}

/** `label`: the words when the pill is not about the end (「回到当前步」 while a turn plays). */
export function JumpPill({ show, unread, running, onJump, label }: { show: boolean; unread: number; running?: boolean; onJump: () => void; label?: string }) {
  const text = label ?? jumpLabel(unread, !!running);
  return (
    <button className="sp-jump" data-show={show || undefined} data-new={unread > 0 || undefined} onClick={onJump} tabIndex={show ? 0 : -1} aria-hidden={!show} aria-label={text} title={label ? undefined : "滚到最新（End）"}>
      {running && <i className="sp-jump-dot" />}
      <span>{text}</span>
    </button>
  );
}
