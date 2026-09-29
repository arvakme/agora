# Canvas ops

`agora canvas apply` takes a JSON array of ops (or `{"ops": [...], "note": "..."}`),
at most 20 per call. Exact schema: `agora canvas schema ops`.

Scene format (from `read`): nodes `{id,type,label,x,y,width,height,frameId?,component?}`
(`type: "library"` = an inserted asset), arrows `{id,start:{id},end:{id},label?,bothEnds?}`,
frames `{id,name,x,y,width,height,children}`. Pixels; x grows right, y grows down;
`(x, y)` is a node's top-left.

| op | fields | effect |
|---|---|---|
| `update_text` | `id, text` | a node's label, an arrow's label, or a frame's name |
| `move` | `id, x, y` | new top-left; bound arrows follow, a frame moves its children |
| `resize` | `id, width, height` | keeps the top-left |
| `add_shape` | `ref, shape (rectangle\|ellipse\|diamond), text, x, y, width?, height?, frameId?` | new node, default 160×64; `ref` (lowercase `[a-z0-9_-]`) becomes its id and can be used by later ops in the same call |
| `add_arrow` | `from, to, text?, bothEnds?, ref?` | straight arrow bound to two nodes (ids or refs) |
| `delete` | `id` | deleting a node keeps its arrows — delete those explicitly when they should go |
| `insert_library_item` | `ref, item, near:{id, side (right\|left\|above\|below), gap?} \| at:{x,y}, label?, width?, frameId?` | a ready-made component; `item` is an id from `search` |

Layout: target ids from the scene, never invented ones; leave ≥ 40 px between nodes and
keep existing sizes unless asked; place components with `near.gap ≥ 40`. Skip `label` on
an asset whose search result has `hasText: true` (it already shows its name). Touch only
what the request is about. Laying out a new sub-diagram: see nested.md (layers, upstream on top).

If the request cannot be done on this canvas, apply nothing and say why.

## Readable diagrams

Lines that cross, run through a box or pile onto one spot make a diagram unreadable, so measure it and fix
what the measure says. Upstream on top, downstream below (the caller above what it calls).

1. **Draw new shapes with `x: 0, y: 0` and end the batch with `{"op": "layout"}`.** It places only the
   shapes and lines *this batch* adds: layers top to bottom, order chosen to cross as little as possible,
   lines straight when clean and elbowed around boxes otherwise, several lines on one side of a box
   spread apart, an unavoidable crossing drawn as a small hop. Nodes already on the canvas (yours from an
   earlier batch, or the person's) stay exactly where they are; the new ones are placed around them.
   It must be the last op. `{"op": "layout", "bus": true}` draws a fan of 4+ lines out of (or into) one
   box as one trunk to a small dot and branches from it: use it for a hub such as a gateway or a database.
2. **The answer of `apply` carries `lint`** (also `agora canvas lint`): one sentence
   (`8 个节点、9 条线：没有交叉，…；线总长 …`) and lists naming the pairs, boxes and lines to change.
   Aim for: 0 crossings, 0 lines through unrelated boxes, 0 overlaps, no `stackedAnchors`, no `textOverflow`
   (new shapes without `width`/`height` are sized to their label by `layout`; for old ones `resize`).
   A hop ("另有 N 处跳线") is fine: it shows two lines that are not connected.
3. **Crossings will not go down?** The layer is too wide or too tangled: split it into a child canvas
   ([nested.md](nested.md)) or merge boxes that always travel together. Adding more lines to a clean diagram is
   how it becomes a hairball; ≥ 10 boxes on one canvas is already a reason to split.
4. **Never re-arrange what is already there.** Moving existing nodes is a separate, explicit act:
   `agora canvas layout --nodes a,b,c` (or `--all`) *only says* what would move and how the diagram
   measures before and after; add `--apply` after the person agreed. Never for a diagram the person drew.

`read` shows a line's `path` (its points) when it is not the plain straight arrow, and `junctions` (the small
dots where lines meet: they are not nodes and `lint` does not count them).
