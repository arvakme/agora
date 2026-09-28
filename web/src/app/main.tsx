import { createRoot } from "react-dom/client";
import "./tokens.css";
import "./theme";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { App, prepareBoot, type Boot, type WorkspaceState } from "./App";
import { IconTerminal } from "./icons";
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
  // Every canvas on disk, listed or not: recovery mode (prepareBoot) rebuilds the list from them.
  const canvases: Boot["canvases"] = {};
  for (const [id, c] of Object.entries(p.canvases)) canvases[id] = { elements: c.elements, threads: c.threads ?? { threads: [], seq: 0 } };
  return { workspace: workspace?.docs?.length ? workspace : undefined, canvases, project: p.project, empty: p.empty, errors: p.errors };
}

function Offline({ error }: { error: unknown }) {
  // The server answered with an error (not a network failure): say so instead of "not connected".
  const answered = /^(GET|POST) \S+: \d{3}/.test(String((error as Error)?.message ?? error));
  return (
    <div className="offline">
      <main>
        <IconTerminal size={56} />
        <h1>{answered ? "项目服务出错了" : "没有连上项目服务"}</h1>
        {answered ? (
          <p>项目服务在运行，但读取项目时出错了。看下面的错误，或查看 <code>.agora/run/server.log</code>。</p>
        ) : (
          <>
            <p>画布、评论和会话存在项目目录的 <code>.agora/</code> 里，由这个项目自己的 Agora 服务读写。在项目目录运行</p>
            <pre>agora up</pre>
            <p>再打开它给出的地址（或用 <code>agora open</code>）。</p>
          </>
        )}
        <p className="offline-detail">{String(error)}</p>
        <a href="?fresh">不保存，直接试用 →</a>
      </main>
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
    (b) => root.render(<App boot={prepareBoot(b)} />),
    (e) => root.render(<Offline error={e} />),
  );
