# Animation scripts

`agora canvas anim` takes one script object. You never produce frames: only the initial
nodes and a list of steps; the player interpolates between steps. Exact schema:
`agora canvas schema anim`.

```json
{
  "title": "冒泡排序 [5, 1, 4]",
  "nodes": [
    {"id": "n0", "text": "5", "x": 0, "y": 0},
    {"id": "n1", "text": "1", "x": 80, "y": 0},
    {"id": "n2", "text": "4", "x": 160, "y": 0},
    {"id": "i", "text": "i", "x": 0, "y": 84, "w": 64, "h": 32}
  ],
  "steps": [
    {"actions": [{"do": "highlight", "ids": ["n0", "n1"], "color": "compare"}, {"do": "caption", "text": "比较 5 和 1"}]},
    {"actions": [{"do": "swap", "a": "n0", "b": "n1"}, {"do": "caption", "text": "5 > 1，交换"}]}
  ]
}
```

Ids are lowercase `[a-z][a-z0-9_-]*`; a node is `{id, text, x, y, w?, h?, shape? (rectangle|ellipse)}`;
`edges: [{from, to}]` is optional.

- Coordinates are pixels relative to the animation region's top-left; nodes default to 64×64.
- Arrays: cells in a row, `x = index*80, y = 0`. Pointers (`lo`, `hi`, `i`, `j`): `w 64, h 32`,
  labels ≤ 4 chars, x aligned with their cell, each on its own row (`y = 84, 124, 164, …`).
- Graphs: nodes by level (`dy = 120`) plus `edges`; graph nodes normally stay put.
- Every node the animation needs exists from the start (`text: ""`, then `set_label`).

Each step is `{"actions": [...]}`, primitives that run together:

| primitive | fields |
|---|---|
| `swap` | `a, b` — exchange positions |
| `move` | `id, x, y` |
| `highlight` | `ids, color` — `compare \| swap \| done \| focus \| visited \| muted` |
| `unhighlight` | `ids?` — omitted = every node; applied before same-step highlights |
| `set_label` | `id, text` |
| `caption` | `text` — the step's explanation, at most one per step |

Within a step a node moves, highlights and relabels at most once. Run the algorithm
faithfully on the given input, one step per meaningful event, aim for ≤ 80 steps (hard limit 300), each captioned
in the person's language. Title: short, including the input.
