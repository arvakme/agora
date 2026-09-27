import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { App, type Boot, type WorkspaceState } from "./App";
import { connect, PERSIST } from "../persist";
import { sessions } from "../session/store";
import { setIdentity } from "../comments/threads";
import { agents, connectAgents } from "../session/agents";
import { installBridge } from "../session/agentBridge";
import { followProject } from "../persist";
import { GUEST } from "../guest/mode";
import { Ended, GuestApp, GuestEnded, loadGuest } from "../guest/GuestApp";

const root = createRoot(document.getElementById("root")!);

/** Restore the project's workspace (canvases, threads, sessions, layout) before first render. */
async function boot(): Promise<Boot> {
  if (!PERSIST) return { canvases: {} };
  const p = await connect();
  setIdentity(p.project.me);
  document.title = `${p.project.name} · Agora`;
  if (Object.keys(p.sessions.sessions).length) sessions.hydrate(p.sessions);
  agents.hydrateBindings(p.bindings);
  // This page executes `agora canvas …` edits and follows the agent sessions live.
  installBridge();
  connectAgents();
  // Comments written by share guests arrive while the page is open.
  followProject(() => dispatchEvent(new Event("agora:shares")));
  const workspace = p.workspace as WorkspaceState | undefined;
  const canvases: Boot["canvases"] = {};
  for (const d of workspace?.docs ?? []) {
    const c = d.kind === "canvas" && p.canvases[d.id];
    if (c) canvases[d.id] = { elements: c.elements, threads: c.threads ?? { threads: [], seq: 0 } };
  }
  return { workspace: workspace?.docs?.length ? workspace : undefined, canvases, project: p.project };
}

function Offline({ error }: { error: unknown }) {
  return (
    <div className="offline">
      <h1>没有连上项目服务</h1>
      <p>画布、评论和会话存在项目目录的 <code>.agora/</code> 里，由这个项目自己的 Agora 服务读写。在项目目录运行</p>
      <pre>agora up</pre>
      <p>再打开它给出的地址（或用 <code>agora open</code>）。</p>
      <p className="offline-detail">{String(error)}</p>
      <a href="?fresh">不保存，直接试用 →</a>
    </div>
  );
}

if (GUEST)
  loadGuest().then(
    (s) => root.render(<GuestApp initial={s} />),
    (e) => root.render(e instanceof Ended ? <GuestEnded /> : <Offline error={e} />),
  );
else
  boot().then(
    (b) => root.render(<App boot={b} />),
    (e) => root.render(<Offline error={e} />),
  );
