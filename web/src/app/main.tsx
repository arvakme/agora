import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { App, type Boot, type WorkspaceState } from "./App";
import { load, PERSIST } from "../persist";
import { sessions } from "../session/store";

const root = createRoot(document.getElementById("root")!);

/** Restore the saved workspace (canvases, threads, sessions, layout) before first render. */
async function boot(): Promise<Boot> {
  if (!PERSIST) return { canvases: {} };
  const workspace = await load<WorkspaceState>("workspace");
  const saved = await load<ReturnType<typeof sessions.snapshot>>("sessions");
  if (saved) sessions.hydrate(saved);
  const canvases: Boot["canvases"] = {};
  for (const d of workspace?.docs ?? []) {
    if (d.kind !== "canvas") continue;
    const c = await load<Boot["canvases"][string]>(`canvas:${d.id}`);
    if (c) canvases[d.id] = c;
  }
  // v2 workspaces may legitimately have no sessions (all deleted). An unversioned one saved
  // before sessions existed references none; start over then.
  return workspace && (workspace.v === 2 || workspace.docs.some((d) => d.kind === "session")) ? { workspace, canvases } : { canvases };
}

void boot().then((b) => root.render(<App boot={b} />));
