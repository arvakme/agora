// What a guest's page does when it re-asks the server about where it is (a "scope changed" signal from the stream, a refused request, a poll):
// the decision is pure; the page acts on it. Whole-project shares only change shape (canvases come and go); a single-canvas share that is
// refused has ended.
import { IconEye } from "../app/icons";
import { tr } from "../i18n";

/** What asking came back with: the state, refused (403: that canvas is not in reach any more, or the share ended), nothing to show (404: the project has no canvas), or a failure to try again. */
export type Probe = "ok" | "ended" | "empty" | "failed";
/** update: take the answer; home: load where the share opens (a canvas is gone, or the project is back); empty: show the empty project; ended: the link is over. */
export type Step = "update" | "home" | "empty" | "ended" | "ignore";

export function afterProbe(o: { project: boolean; probe: Probe; showingEmpty: boolean }): Step {
  if (o.showingEmpty) return o.probe === "ok" ? "home" : o.probe === "ended" ? "ended" : "ignore"; // the landing canvas was asked for: a canvas means the project is back
  if (o.probe === "ok") return "update";
  if (o.probe === "empty") return "empty";
  if (o.probe === "ended") return o.project ? "home" : "ended";
  return "ignore";
}

/** The project link is alive but the owner deleted every canvas: said so, until one is made again (the page then comes back by itself). */
export function GuestEmpty() {
  return (
    <div className="guest-empty" role="status">
      <main>
        <IconEye size={48} />
        <h2>{tr("这个项目暂时没有画布", "This project has no canvases yet")}</h2>
        <p>{tr("作者新建画布后，这里会自动出现，不用刷新。", "When the author creates a canvas, it shows up here automatically, no refresh needed.")}</p>
      </main>
    </div>
  );
}
