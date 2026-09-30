# Nested canvases (子图)

A node can open a child canvas one level more detailed (overview → a service's modules → a
module's call flow). `read` shows a node's `child: {canvasId, name}`, and on a child canvas
`canvas.parent` and `canvas.path` (the breadcrumb). Behaviour: web/docs/nested-canvas.md.

**Macro to micro.** Draw a system as levels, each one whole when read alone: level 1 the overview (5–9
boxes that fit one screen), level 2 one child canvas per subsystem (its modules, again 5–9), level 3 only when
asked (a module's call flow). One level per pass: draw it, `lint` it, then go down; never fill three
levels at once. A box that needs more than one sentence to explain, or a level over ~9 boxes, becomes a child canvas.

Expanding a node (「展开」, 「画出 X 的内部」):

1. `agora canvas child create --parent <canvas> --node <id or label>` → `created` (blank canvas
   named after the node, `--title` renames) or `exists` (update that one). Use the returned `canvas.id`.
2. Read the code the node stands for (its `codePaths`, or find it by name).
3. `agora canvas read --canvas <child>`, then `apply --canvas <child>`: the inner modules and
   the calls between them, one level down, not the whole codebase, ending the batch with `{"op": "layout"}`
   (canvas-ops.md §Readable diagrams): upstream on top, downstream below (the caller above what it calls),
   so most arrows run down and an agent's figure walks them as ladders. What several nodes share (a cache,
   a database) goes in a lower layer with a few arrows pointing at it: that is layering, not a tree.
   Check `lint` in the answer; crossings you cannot remove mean the level is too wide: split it.
   Never re-arrange a diagram a person drew (their positions mean something).
4. `agora canvas link --canvas <child> …` its nodes to their finer code.
5. Tell the person in a sentence or two what the child shows.

Also `child list [--parent <canvas>]`, `child link --node N --child <canvas>` (loops refused),
`child unlink --node N` (the child canvas stays).
