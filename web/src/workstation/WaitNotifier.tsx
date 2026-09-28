// 等你就叫你 (web/docs/workstation.md「新想法」): while the page is hidden, an agent that starts waiting on
// you raises one system notification (its question; clicking it brings the page back); when the page
// is in view again, `attention` pings and the figures waiting on you wave. Renders nothing: mount it
// once (App). Watches the runs store and the page's visibility directly, so a background tab that
// React does not paint still notices. The ⋯ menu's switch is `setWaitNotify`.
import { useEffect } from "react";
import { prefs } from "../app/prefs";
import { attention } from "./attention";
import { waitsToTell } from "./notify";
import { runs } from "./runs/store";

export const canNotify = () => typeof Notification !== "undefined";
/** The browser said no: the switch stays off and says so. */
export const notifyBlocked = () => canNotify() && Notification.permission === "denied";

/** The ⋯ menu's switch. Turning it on asks the browser first, inside the click (browsers require a gesture). */
export async function setWaitNotify(on: boolean) {
  if (!on || !canNotify()) return prefs.set({ notifyWait: false });
  const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  prefs.set({ notifyWait: p === "granted" });
}

export function WaitNotifier() {
  useEffect(() => {
    // when the page was last in view: only waits that began after it are news
    let since = Date.now();
    const told = new Set<string>();
    const check = () => {
      if (document.visibilityState !== "hidden" || !prefs.get().notifyWait || !canNotify() || Notification.permission !== "granted") return;
      for (const w of waitsToTell(runs.get().flat, since, Date.now(), told)) {
        told.add(w.key);
        const n = new Notification(w.title, { body: w.body, tag: w.key });
        n.onclick = () => (window.focus(), n.close());
      }
    };
    const seen = () => {
      since = Date.now();
      if (document.visibilityState === "visible") attention.ping();
    };
    document.addEventListener("visibilitychange", seen);
    const off = runs.subscribe(check);
    return () => (document.removeEventListener("visibilitychange", seen), off());
  }, []);
  return null;
}
