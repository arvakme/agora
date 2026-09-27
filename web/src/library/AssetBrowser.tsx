// "素材" tab in Excalidraw's sidebar: the built-in asset library for people. Search goes
// through the same service the agent's search_library tool uses; browsing is grouped
// by source → library; thumbnails render lazily with Excalidraw's own exporter.
// Clicking a component inserts it at the centre of the view as one undoable step.
import { CaptureUpdateAction, exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { instantiate, type LibraryItem } from "./libraryInsert";
import type { El } from "../canvas/scene";

type Hit = { id: string; name: string; library: string; source: string; license: string; size: { w: number; h: number } };
type Lib = { key: string; source: string; name: string; license: string; items: number; file: string };
const SOURCE_NAMES: Record<string, string> = { official: "Excalidraw 官方库", lucide: "Lucide 图标" };

const fileCache = new Map<string, Promise<{ items: { id: string; name: string; elements: unknown[] }[] }>>();
const loadFile = (file: string) => {
  if (!fileCache.has(file)) fileCache.set(file, fetch(`/libraries/${file}`).then((r) => r.json()));
  return fileCache.get(file)!;
};
const itemCache = new Map<string, Promise<LibraryItem>>();
const loadItem = (id: string) => {
  if (!itemCache.has(id)) itemCache.set(id, fetch(`/api/canvas/library/item?id=${encodeURIComponent(id)}`).then((r) => r.json()));
  return itemCache.get(id)!;
};

export function AssetBrowser({ api }: { api: ExcalidrawImperativeAPI }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [libs, setLibs] = useState<Lib[]>([]);
  const [openLib, setOpenLib] = useState<Lib | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => void fetch("/api/canvas/library/libs").then((r) => r.json()).then((d) => setLibs(d.libraries ?? [])), []);
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    const t = setTimeout(() => void fetch(`/api/canvas/library/search?q=${encodeURIComponent(q)}&limit=24`).then((r) => r.json()).then((d) => setHits(d.items ?? [])), 150);
    return () => clearTimeout(t);
  }, [q]);

  const bySource = useMemo(() => {
    const m = new Map<string, Lib[]>();
    for (const l of libs) m.set(l.source, [...(m.get(l.source) ?? []), l]);
    return [...m].sort(([a], [b]) => (a === "official" ? -1 : b === "official" ? 1 : a === "lucide" ? 1 : b === "lucide" ? -1 : a.localeCompare(b)));
  }, [libs]);

  const insert = async (id: string) => {
    const item = await loadItem(id);
    const a = api.getAppState();
    const cx = a.width / 2 / a.zoom.value - a.scrollX, cy = a.height / 2 / a.zoom.value - a.scrollY;
    const ref = `asset-${Math.random().toString(36).slice(2, 7)}`;
    const probe = instantiate(item, { ref, at: { x: 0, y: 0 } })[0];
    const els = instantiate(item, { ref, at: { x: cx - probe.width / 2, y: cy - probe.height / 2 }, side: "right", obstacles: api.getSceneElements() as El[] });
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...els] as El[], appState: { selectedGroupIds: { [els[0].groupIds[0]]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setFlash(item.name);
    setTimeout(() => setFlash(null), 1400);
  };

  return (
    <div className="assets" onKeyDown={(e) => e.stopPropagation()}>
      <input className="assets-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索素材：redis、aws lambda、用户…" aria-label="搜索素材" />
      {flash && <div className="assets-flash">已插入「{flash}」</div>}
      {hits ? (
        <>
          <div className="assets-head">{hits.length ? `${hits.length} 个结果` : "没有匹配的素材"}</div>
          <Grid ids={hits.map((h) => ({ id: h.id, title: `${h.name} · ${h.library} · ${h.license}` }))} onPick={insert} />
        </>
      ) : openLib ? (
        <>
          <button className="assets-back" onClick={() => setOpenLib(null)}>← {openLib.name}<span>{openLib.items} 个 · {openLib.license}</span></button>
          <LibGrid lib={openLib} onPick={insert} />
        </>
      ) : (
        <div className="assets-sources">
          {bySource.map(([source, ls]) => (
            <details key={source} open={source === "official"}>
              <summary>
                {SOURCE_NAMES[source] ?? source}
                <span>{ls.length} 个库 · {ls.reduce((n, l) => n + l.items, 0)} 个组件 · {ls[0].license}</span>
              </summary>
              <ul>
                {ls.map((l) => (
                  <li key={l.key}>
                    <button onClick={() => setOpenLib(l)}>{l.name}<span>{l.items}</span></button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function LibGrid({ lib, onPick }: { lib: Lib; onPick: (id: string) => void }) {
  const [ids, setIds] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => void loadFile(lib.file).then((f) => setIds(f.items.map((i) => ({ id: i.id, title: i.name || lib.name })))), [lib]);
  return <Grid ids={ids} onPick={onPick} />;
}

function Grid({ ids, onPick }: { ids: { id: string; title: string }[]; onPick: (id: string) => void }) {
  return (
    <div className="assets-grid">
      {ids.map((x) => <Thumb key={x.id} id={x.id} title={x.title} onPick={onPick} />)}
    </div>
  );
}

/** Renders a component preview only once it scrolls into view. */
function Thumb({ id, title, onPick }: { id: string; title: string; onPick: (id: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const item = await loadItem(id);
      const node = await exportToSvg({ elements: item.elements as never, appState: { exportBackground: false }, files: null, exportPadding: 4 });
      node.removeAttribute("width");
      node.removeAttribute("height");
      setSvg(node.outerHTML);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [id]);
  return (
    <button ref={ref} className="assets-thumb" title={title} onClick={() => onPick(id)}>
      {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : <i />}
      <em>{title.split(" · ")[0]}</em>
    </button>
  );
}
