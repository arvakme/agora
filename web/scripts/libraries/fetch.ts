// Rebuilds the bundled asset library from libraries/sources.json. Re-runnable and
// deterministic for pinned refs: every source is fetched at its pinned commit / npm
// version, licenses are re-checked against the GitHub API, each file's sha256 is
// recorded in libraries/manifest.json, and items are normalized, de-duplicated and
// indexed into libraries/catalog.json (the only file the agent search reads).
//
//   npm run libraries:fetch            # fetch + build
//   npm run libraries:fetch -- --check # verify vendored files still match manifest
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { svgPathProperties } from "svg-path-properties";

const ROOT = new URL("../../libraries/", import.meta.url).pathname;
const sources = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8"));
const labels: Record<string, { name: string; keywords: string[] }> = existsSync(join(ROOT, "labels.json"))
  ? JSON.parse(readFileSync(join(ROOT, "labels.json"), "utf8"))
  : {};
const token = process.env.GITHUB_TOKEN ?? tryExec("gh auth token");
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

function tryExec(cmd: string) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}
async function gh(path: string) {
  const r = await fetch(`https://api.github.com/${path}`, { headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw new Error(`GitHub ${path}: ${r.status}`);
  return r.json();
}
const CACHE = new URL("../../.cache/libraries/", import.meta.url).pathname;
async function raw(repo: string, ref: string, path: string) {
  const cached = join(CACHE, repo, ref, path);
  if (existsSync(cached)) return readFileSync(cached, "utf8");
  const text = await rawFetch(repo, ref, path);
  mkdirSync(join(cached, ".."), { recursive: true });
  writeFileSync(cached, text);
  return text;
}
async function rawFetch(repo: string, ref: string, path: string) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path.split("/").map(encodeURIComponent).join("/")}`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.text();
    if (attempt === 2) throw new Error(`raw ${repo}@${ref}:${path} ${r.status}`);
    await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1)));
  }
}
async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < xs.length) {
      const k = i++;
      out[k] = await f(xs[k]);
    }
  }));
  return out;
}

// ——— normalization ———
type El = Record<string, unknown> & { type: string; x: number; y: number; width: number; height: number; points?: number[][]; text?: string };
type Item = { id: string; name: string; elements: El[] };
const DROP = new Set(["versionNonce", "updated", "link", "locked", "index", "frameId", "boundElementIds", "isDeleted", "version"]);
const OK_TYPES = new Set(["rectangle", "ellipse", "diamond", "line", "arrow", "text", "freedraw"]);
const round = (v: unknown): unknown =>
  typeof v === "number" ? Math.round(v * 100) / 100 : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !DROP.has(k)).map(([k, x]) => [k, round(x)])) : v;

function normalize(elements: unknown[]): El[] | null {
  const els = (elements as El[]).filter((e) => e && !(e as { isDeleted?: boolean }).isDeleted);
  if (!els.length || els.some((e) => !OK_TYPES.has(e.type))) return null;
  return els.map((e) => round(e) as El);
}
function bbox(els: El[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    const pts = e.points?.length ? e.points.map(([px, py]) => [e.x + px, e.y + py]) : [[e.x, e.y], [e.x + e.width, e.y + e.height]];
    for (const [px, py] of pts) (x0 = Math.min(x0, px)), (y0 = Math.min(y0, py)), (x1 = Math.max(x1, px)), (y1 = Math.max(y1, py));
  }
  return { w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}
/** Geometry fingerprint used to de-duplicate mirrors (ignores ids, seeds, names). */
function fingerprint(els: El[]) {
  return sha256(JSON.stringify(els.map((e) => [e.type, e.x, e.y, e.width, e.height, e.points ?? null, e.text ?? null])));
}
const textOf = (els: El[]) =>
  [...new Set(els.filter((e) => e.type === "text").map((e) => String(e.text ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))].join(" / ").slice(0, 60);

function readLib(json: string): { name: string; elements: unknown[] }[] {
  const d = JSON.parse(json);
  if (Array.isArray(d.libraryItems)) return d.libraryItems.map((i: { name?: string; elements: unknown[] }) => ({ name: i.name ?? "", elements: i.elements }));
  if (Array.isArray(d.library)) return d.library.map((els: unknown[]) => ({ name: "", elements: els }));
  return [];
}

// ——— Lucide → native Excalidraw strokes ———
const SCALE = 2; // 24px viewBox → 48px items
let seed = 1;
function lucideElements(nodes: [string, Record<string, string>][], group: string): El[] {
  const base = (type: string, x: number, y: number, w: number, h: number, extra: object = {}): El => ({
    type, x, y, width: w, height: h, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [group], roundness: null, seed: seed++, boundElements: null, ...extra,
  });
  const line = (pts: number[][]): El => {
    const [ox, oy] = pts[0];
    const rel = pts.map(([x, y]) => [round((x - ox) * SCALE) as number, round((y - oy) * SCALE) as number]);
    const xs = rel.map((p) => p[0]), ys = rel.map((p) => p[1]);
    return base("line", round(ox * SCALE) as number, round(oy * SCALE) as number, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
      points: rel, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null,
    });
  };
  const n = (v: string | undefined) => Number(v ?? 0);
  const out: El[] = [];
  for (const [tag, a] of nodes) {
    if (tag === "circle") out.push(base("ellipse", (n(a.cx) - n(a.r)) * SCALE, (n(a.cy) - n(a.r)) * SCALE, 2 * n(a.r) * SCALE, 2 * n(a.r) * SCALE));
    else if (tag === "ellipse") out.push(base("ellipse", (n(a.cx) - n(a.rx)) * SCALE, (n(a.cy) - n(a.ry)) * SCALE, 2 * n(a.rx) * SCALE, 2 * n(a.ry) * SCALE));
    else if (tag === "rect") out.push(base("rectangle", n(a.x) * SCALE, n(a.y) * SCALE, n(a.width) * SCALE, n(a.height) * SCALE, a.rx ? { roundness: { type: 3, value: n(a.rx) * SCALE } } : {}));
    else if (tag === "line") out.push(line([[n(a.x1), n(a.y1)], [n(a.x2), n(a.y2)]]));
    else if (tag === "polyline" || tag === "polygon") {
      const pts = a.points.trim().split(/[\s,]+/).map(Number).reduce<number[][]>((acc, v, i) => (i % 2 ? acc[acc.length - 1].push(v) : acc.push([v]), acc), []);
      out.push(line(tag === "polygon" ? [...pts, pts[0]] : pts));
    } else if (tag === "path") {
      // Sample the true curve; start a new polyline wherever the pen jumps (subpaths).
      const parts = new svgPathProperties(expandArcFlags(a.d)).getParts();
      let pts: number[][] = [];
      for (const part of parts) {
        const steps = Math.max(1, Math.min(32, Math.ceil(part.length / 1.2)));
        const fresh: number[][] = [];
        for (let i = 0; i <= steps; i++) {
          const q = part.getPointAtLength((part.length * i) / steps);
          if (q && Number.isFinite(q.x) && Number.isFinite(q.y)) fresh.push([q.x, q.y]);
        }
        if (!fresh.length) continue;
        const last = pts[pts.length - 1];
        if (last && Math.hypot(last[0] - fresh[0][0], last[1] - fresh[0][1]) < 1e-3) pts.push(...fresh.slice(1));
        else {
          if (pts.length > 1) out.push(line(pts));
          pts = fresh;
        }
      }
      if (pts.length > 1) out.push(line(pts));
    }
  }
  return out.map((e, i) => ({ ...e, id: `${group}-${i}` }));
}

/** SVG allows packed arc flags ("a2 2 0 001.68-.92"); the path library needs them spelled out. */
function expandArcFlags(d: string) {
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;
  const out: string[] = [];
  let cmd = "", argi = 0;
  const src = d;
  let pos = 0;
  while (pos < src.length) {
    const ch = src[pos];
    if (/[\s,]/.test(ch)) { pos++; continue; }
    if (/[A-Za-z]/.test(ch)) { cmd = ch; argi = 0; out.push(ch); pos++; continue; }
    // Arc flags (args 4 and 5 of each 7-tuple) are a single 0/1 digit.
    if ((cmd === "a" || cmd === "A") && (argi % 7 === 3 || argi % 7 === 4)) { out.push(src[pos]); pos++; argi++; continue; }
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m.index !== pos) throw new Error(`bad path near ${src.slice(pos, pos + 12)}`);
    out.push(m[0]);
    pos += m[0].length;
    argi++;
  }
  return out.join(" ");
}

// ——— main ———
const check = process.argv.includes("--check");
if (check) {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  let bad = 0;
  for (const f of manifest.outputs) if (sha256(readFileSync(join(ROOT, f.path))) !== f.sha256) (bad++, console.error("changed:", f.path));
  console.log(bad ? `${bad} vendored files differ from manifest` : `ok: ${manifest.outputs.length} vendored files match manifest`);
  process.exit(bad ? 1 : 0);
}

type Lib = { key: string; source: string; name: string; description: string; authors: { name: string; url?: string }[]; origin: string; license: string; items: Item[] };
const libs: Lib[] = [];
const manifestSources: object[] = [];
const seen = new Map<string, { lib: Lib; item: Item }>();
const extraNames = new Map<Item, Set<string>>();
const extraTags: Record<string, string[]> = {};
const stats: Record<string, { files: number; items: number; kept: number; dup: number; skipped: number }> = {};
const licenseText: Record<string, string> = {};

async function verifyLicense(repo: string, expected: string, id: string) {
  const l = await gh(`repos/${repo}/license`);
  if (l.license?.spdx_id !== expected) throw new Error(`${repo}: license is ${l.license?.spdx_id}, sources.json says ${expected}`);
  licenseText[id] = Buffer.from(l.content, "base64").toString("utf8");
}

function addLib(lib: Lib, rawItems: { name: string; elements: unknown[] }[], mode: true | "merge-names") {
  const s = (stats[lib.source] ??= { files: 0, items: 0, kept: 0, dup: 0, skipped: 0 });
  s.files++;
  const items: Item[] = [];
  rawItems.forEach((ri, i) => {
    s.items++;
    const els = normalize(ri.elements ?? []);
    if (!els) return void s.skipped++;
    const fp = fingerprint(els);
    const prior = seen.get(fp);
    if (prior) {
      s.dup++;
      if (ri.name && ri.name !== prior.item.name) (extraNames.get(prior.item) ?? extraNames.set(prior.item, new Set()).get(prior.item)!).add(ri.name);
      return;
    }
    if (mode === "merge-names") return void s.skipped++;
    const item = { id: `${lib.key}#${i}`, name: ri.name?.trim() ?? "", elements: els };
    seen.set(fp, { lib, item });
    items.push(item);
    s.kept++;
  });
  if (mode === true && items.length) libs.push({ ...lib, items });
}

// 1. Official catalog.
{
  const o = sources.official;
  await verifyLicense(o.repo, o.license, o.id);
  const index = JSON.parse(await raw(o.repo, o.ref, "libraries.json"));
  const files: object[] = [];
  const texts = await pool(index, 12, async (e: { source: string }) => raw(o.repo, o.ref, `libraries/${e.source}`));
  index.forEach((e: { id: string; name: string; description: string; authors: Lib["authors"]; source: string }, i: number) => {
    files.push({ path: `libraries/${e.source}`, sha256: sha256(texts[i]) });
    addLib({ key: `official/${e.source.replace(/\.excalidrawlib$/, "")}`, source: o.id, name: e.name, description: e.description, authors: e.authors, origin: `https://github.com/${o.repo}/blob/${o.ref}/libraries/${e.source}`, license: o.license, items: [] }, readLib(texts[i]), true);
  });
  manifestSources.push({ id: o.id, repo: o.repo, ref: o.ref, license: o.license, files });
  console.log(`official: ${index.length} libraries`);
}

// 2. Community repositories.
for (const c of sources.community) {
  const tree = await gh(`repos/${c.repo}/git/trees/${c.ref}?recursive=1`);
  const paths: string[] = tree.tree.filter((t: { path: string }) => t.path.endsWith(".excalidrawlib")).map((t: { path: string }) => t.path);
  if (!c.bundle) {
    manifestSources.push({ id: c.id, repo: c.repo, ref: c.ref, license: c.license, bundle: false, reason: c.reason, files: paths.length });
    stats[c.id] = { files: paths.length, items: 0, kept: 0, dup: 0, skipped: 0 };
    continue;
  }
  await verifyLicense(c.repo, c.license, c.id);
  const texts = await pool(paths, 8, (p) => raw(c.repo, c.ref, p));
  const files: object[] = [];
  paths.forEach((p, i) => {
    files.push({ path: p, sha256: sha256(texts[i]) });
    const name = p.split("/").pop()!.replace(/\.excalidrawlib$/, "").replace(/[-_]+/g, " ");
    addLib({ key: `${c.id}/${p.replace(/\.excalidrawlib$/, "").replace(/^libraries\//, "")}`, source: c.id, name, description: "", authors: [{ name: c.repo.split("/")[0], url: `https://github.com/${c.repo.split("/")[0]}` }], origin: `https://github.com/${c.repo}/blob/${c.ref}/${p}`, license: c.license, items: [] }, readLib(texts[i]), c.bundle);
  });
  manifestSources.push({ id: c.id, repo: c.repo, ref: c.ref, license: c.license, bundle: c.bundle, files });
  console.log(`${c.id}: ${paths.length} files`);
}

// 3. Icon sets (npm packages, converted to native strokes).
for (const ic of sources.icons) {
  const dir = mkdtempSync(join(tmpdir(), "agora-icons-"));
  execFileSync("npm", ["pack", `${ic.package}@${ic.version}`, "--silent"], { cwd: dir });
  const tgz = `${ic.package}-${ic.version}.tgz`;
  execFileSync("tar", ["xzf", tgz, "package/icon-nodes.json", "package/tags.json", "package/LICENSE"], { cwd: dir });
  const nodes: Record<string, [string, Record<string, string>][]> = JSON.parse(readFileSync(join(dir, "package/icon-nodes.json"), "utf8"));
  const tags: Record<string, string[]> = JSON.parse(readFileSync(join(dir, "package/tags.json"), "utf8"));
  licenseText[ic.id] = readFileSync(join(dir, "package/LICENSE"), "utf8");
  const tarSha = sha256(readFileSync(join(dir, tgz)));
  rmSync(dir, { recursive: true, force: true });
  const names = Object.keys(nodes).sort();
  // Group icons into libraries by first letter so the panel stays browsable.
  const byLetter = new Map<string, { name: string; elements: El[] }[]>();
  for (const n of names) {
    const els = lucideElements(nodes[n], `lucide-${n}`);
    if (!els.length) continue;
    const k = n[0];
    byLetter.set(k, [...(byLetter.get(k) ?? []), { name: n, elements: els }]);
    (extraTags[`${ic.id}/${k}#${byLetter.get(k)!.length - 1}`] = tags[n] ?? []);
  }
  for (const [k, items] of byLetter)
    addLib({ key: `${ic.id}/${k}`, source: ic.id, name: `Lucide · ${k.toUpperCase()}`, description: "Lucide icons converted to native Excalidraw strokes", authors: [{ name: "Lucide Contributors", url: "https://lucide.dev" }], origin: `https://www.npmjs.com/package/${ic.package}/v/${ic.version}`, license: ic.license, items: [] }, items, true);
  manifestSources.push({ id: ic.id, package: ic.package, version: ic.version, license: ic.license, tarballSha256: tarSha, icons: names.length });
  console.log(`${ic.id}: ${names.length} icons`);
}

// ——— write outputs ———
const STOP = new Set("a an and the of for to in on with by or is are this that from your you it as at be library libraries icons icon set".split(" "));
const words = (s: string) => s.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w) && w.length < 30);
const outputs: { path: string; sha256: string }[] = [];
const catalogItems: object[] = [];
let named = { library: 0, text: 0, model: 0, none: 0 };
rmSync(join(ROOT, "items"), { recursive: true, force: true });
for (const lib of libs) {
  const file = `items/${lib.key.replace(/[^\w/.-]+/g, "_")}.json`;
  (lib as Lib & { file?: string }).file = file;
  const body = JSON.stringify({ library: { key: lib.key, name: lib.name, license: lib.license, origin: lib.origin }, items: lib.items.map((i) => ({ id: i.id, name: i.name, elements: i.elements })) });
  mkdirSync(join(ROOT, file, ".."), { recursive: true });
  writeFileSync(join(ROOT, file), body);
  outputs.push({ path: file, sha256: sha256(body) });
  for (const it of lib.items) {
    let name = it.name, how: keyof typeof named = "library";
    if (!name) (name = textOf(it.elements)), (how = "text");
    if (!name && labels[it.id]) (name = labels[it.id].name), (how = "model");
    if (!name) how = "none";
    named[how]++;
    const kw = new Set([...words(name), ...words(lib.name), ...words(lib.description).slice(0, 12), ...(extraTags[it.id] ?? []).flatMap(words), ...(labels[it.id]?.keywords ?? []).flatMap(words), ...[...(extraNames.get(it) ?? [])].flatMap(words)]);
    const { w, h } = bbox(it.elements);
    catalogItems.push({ id: it.id, lib: lib.key, name, how, kw: [...kw].slice(0, 40), w, h, n: it.elements.length, text: how === "library" ? textOf(it.elements) || undefined : undefined });
  }
}
const catalog = {
  generated: "scripts/libraries/fetch.ts",
  libraries: libs.map((l) => ({ key: l.key, source: l.source, name: l.name, description: l.description, authors: l.authors, license: l.license, origin: l.origin, items: l.items.length, file: (l as Lib & { file?: string }).file })),
  items: catalogItems,
};
writeFileSync(join(ROOT, "catalog.json"), JSON.stringify(catalog));
mkdirSync(join(ROOT, "licenses"), { recursive: true });
for (const [id, t] of Object.entries(licenseText)) writeFileSync(join(ROOT, "licenses", `${id}.txt`), t);
writeFileSync(join(ROOT, "manifest.json"), JSON.stringify({ sources: manifestSources, stats, naming: named, outputs }, null, 1));

// Attribution: every bundled library with authors, origin and license.
const notice = [
  "# Third-party asset libraries",
  "",
  "Generated by `scripts/libraries/fetch.ts` from `libraries/sources.json`. Full license texts are in `libraries/licenses/`.",
  "Items were normalized (ids/nonces dropped, coordinates rounded) and de-duplicated; geometry is otherwise unchanged.",
  "Lucide icons were converted from SVG to native Excalidraw strokes.",
  "",
  "## Trademarks",
  "",
  "Product names, logos and icons in these libraries (for example AWS, Microsoft Azure, Google Cloud, Oracle, Databricks, Snowflake, VMware, Apache Kafka and the technology logos) are trademarks of their respective owners. They are included only to refer to the corresponding products in diagrams; their presence does not imply endorsement by, or any affiliation with, those owners.",
  "",
  "商标归各自所有者。这些名称、标志和图标仅用于在图中指代对应产品，不表示获得其所有者的认可，也不表示与其存在关联。",
  "",
  "## Kafka Streams Topology Design",
  "",
  "`official/hartmut-co-uk/kafka-streams-topology-design` is taken from the copy published in the official excalidraw-libraries repository, which is distributed under that repository's MIT license. The author's standalone repository (thriving-dev/kafka-streams-topology-design) is licensed GPL-3.0; this project uses the official-library copy, not the standalone repository.",
  "",
  "官方库中的副本随官方仓库以 MIT 许可分发；作者的独立仓库为 GPL-3.0。本项目使用的是官方库副本。",
  "",
  "## Libraries",
  "",
  "| Library | Authors | License | Source |",
  "|---|---|---|---|",
  ...libs.map((l) => `| ${l.name.replace(/\|/g, "/")} | ${l.authors.map((a) => (a.url ? `[${a.name}](${a.url})` : a.name)).join(", ")} | ${l.license} | ${l.origin} |`),
].join("\n");
writeFileSync(join(ROOT, "NOTICE.md"), notice + "\n");
console.log(JSON.stringify({ libraries: libs.length, items: catalogItems.length, naming: named, stats }, null, 1));
