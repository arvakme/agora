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
what the request is about.

If the request cannot be done on this canvas, apply nothing and say why.
