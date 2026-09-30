// Preinstalls the built-in asset library into Excalidraw's own Library panel.
// Parsing all ~6k items costs ~50 MB and installing them into one editor ~120 MB,
// so it happens per canvas only when that canvas's Library sidebar is first opened,
// and the fetched items are shared by every canvas. Order = official → community →
// icon sets, so the panel reads grouped by source.
import type { ExcalidrawImperativeAPI, LibraryItems } from "@excalidraw/excalidraw/types";

type Lib = { key: string; source: string; name: string; file: string };
let all: Promise<LibraryItems> | null = null;
const installed = new WeakSet<ExcalidrawImperativeAPI>();
const RANK = (s: string) => (s === "official" ? 0 : s === "lucide" ? 2 : 1);

function loadAll(): Promise<LibraryItems> {
  all ??= (async () => {
    const { libraries: libs } = (await (await fetch("/api/canvas/library/libs")).json()) as { libraries: Lib[] };
    libs.sort((a, b) => RANK(a.source) - RANK(b.source) || a.name.localeCompare(b.name));
    const files = await Promise.all(libs.map((l) => fetch(`/libraries/${l.file}`).then((r) => r.json())));
    return files.flatMap((f: { items: { id: string; name: string; elements: unknown[] }[] }, i) =>
      f.items.map((it) => ({ id: it.id, status: "published" as const, created: 1, name: it.name || libs[i].name, elements: it.elements as never })),
    );
  })();
  return all;
}

/** Call on every onChange; installs once when the Library tab is first shown. */
export function maybeInstallLibrary(api: ExcalidrawImperativeAPI, openSidebar: { name: string; tab?: string } | null) {
  if (installed.has(api) || openSidebar?.name !== "default" || openSidebar.tab === "agora-assets" || openSidebar.tab === "search") return;
  installed.add(api);
  void loadAll().then((libraryItems) => api.updateLibrary({ libraryItems, merge: true, openLibraryMenu: false }));
}
