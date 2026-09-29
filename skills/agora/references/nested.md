# Nested canvases (子图)

A node can open a child canvas one level more detailed (overview → a service's modules → a
module's call flow). `read` shows a node's `child: {canvasId, name}`, and on a child canvas
`canvas.parent` and `canvas.path` (the breadcrumb). Behaviour: web/docs/nested-canvas.md.

Expanding a node (「展开」, 「画出 X 的内部」):

1. `agora canvas child create --parent <canvas> --node <id or label>` → `created` (blank canvas
   named after the node, `--title` renames) or `exists` (update that one). Use the returned `canvas.id`.
2. Read the code the node stands for (its `codePaths`, or find it by name).
3. `agora canvas read --canvas <child>`, then `apply --canvas <child>`: the inner modules and
   the calls between them, one level down, not the whole codebase. Lay a new child out in layers:
   upstream on top, downstream below (the caller above what it calls), so most arrows run down and an
   agent's figure walks them as ladders. What several nodes share (a cache, a database) goes in a lower
   layer with a few arrows pointing at it: that is layering, not a tree. Never re-arrange a diagram a
   person drew (their positions mean something).
4. `agora canvas link --canvas <child> …` its nodes to their finer code.
5. Tell the person in a sentence or two what the child shows.

Also `child list [--parent <canvas>]`, `child link --node N --child <canvas>` (loops refused),
`child unlink --node N` (the child canvas stays).
