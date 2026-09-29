# Nested canvases (子图)

A node can open a child canvas one level more detailed (overview → a service's modules → a
module's call flow). `read` shows a node's `child: {canvasId, name}`, and on a child canvas
`canvas.parent` and `canvas.path` (the breadcrumb). Behaviour: web/docs/nested-canvas.md.

Expanding a node (「展开」, 「画出 X 的内部」):

1. `agora canvas child create --parent <canvas> --node <id or label>` → `created` (blank canvas
   named after the node, `--title` renames) or `exists` (update that one). Use the returned `canvas.id`.
2. Read the code the node stands for (its `codePaths`, or find it by name).
3. `agora canvas read --canvas <child>`, then `apply --canvas <child>`: the inner modules and
   the calls between them, one level down, not the whole codebase.
4. `agora canvas link --canvas <child> …` its nodes to their finer code.
5. Tell the person in a sentence or two what the child shows.

Also `child list [--parent <canvas>]`, `child link --node N --child <canvas>` (loops refused),
`child unlink --node N` (the child canvas stays).
