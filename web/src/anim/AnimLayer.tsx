// Per-canvas host: mounts scripts through the Excalidraw engine and renders one player per region.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { excalidrawEngine } from "./engine-excalidraw.ts";
import { AnimController } from "./player.ts";
import { Player } from "./Player.tsx";
import type { AnimScript } from "./script.ts";
import { compile } from "./timeline.ts";
import "./anim.css";

export type Animate = (script: AnimScript) => AnimController;
/** api → mount function, so the comment agent can reach the host without prop threading. */
export const animHosts = new WeakMap<ExcalidrawImperativeAPI, Animate>();
/** Every live controller, for scripted checks (window.__anim). */
export const controllers: AnimController[] = [];
Object.assign(window, { __anim: controllers });

export function AnimLayer({ api }: { api: ExcalidrawImperativeAPI }) {
  const [live, setLive] = useState<AnimController[]>([]);
  useEffect(() => {
    const animate: Animate = (script) => {
      const tl = compile(script);
      const engine = excalidrawEngine(api);
      engine.mount(tl);
      const ctl = new AnimController(tl, engine);
      controllers.push(ctl);
      setLive((l) => [...l, ctl]);
      return ctl;
    };
    animHosts.set(api, animate);
    return () => void animHosts.delete(api);
  }, [api]);
  return createPortal(
    live.map((ctl, i) => <Player key={i} ctl={ctl} onClose={() => (ctl.pause(), setLive((l) => l.filter((c) => c !== ctl)))} />),
    document.body,
  );
}
