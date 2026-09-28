---
name: agora-canvas
description: Read and change this project's Agora canvas (Excalidraw architecture diagrams with comment threads) through the `agora canvas` CLI — read the diagram, search the icon/asset library, apply typed edits as one undoable change, mount a step-by-step algorithm animation, link diagram elements to code paths for Agora's progress pointer, or expand a node into a nested child canvas (子图). Use when a message comes from Agora or mentions the canvas, diagram, 画布, 架构图, 子图/展开, a comment on it, asks to animate/演示 an algorithm, or to link the diagram to code (关联代码路径).
---

# Agora canvas

The canvas lives in this project's `.agora/`. You never edit those files: you read a
model view, send typed operations, and the open Agora page validates them (schema,
references, freshness), applies them as **one undoable change**, and shows it in the
session. Commands print one JSON object.

`agora` is on PATH in sessions Agora starts; elsewhere run `scripts/agora` from this skill's directory.
The canvas and session default to `$AGORA_CANVAS` / `$AGORA_SESSION`; pass `--canvas <id|name>`
when there are several canvases (`agora canvas list`).

## Edit the diagram

1. `agora canvas read` → `scene` (nodes, arrows, frames) and `base`. Done when you know the
   ids you will touch.
2. Assets — only when the request names a product, technology, device, person or icon:
   `agora canvas search redis` (1–3 English keywords). Use an item `id` from the result;
   plain boxes, notes and generic steps are `add_shape`.
3. Write the smallest set of ops that does what was asked ([ops reference](references/ops.md)),
   then apply them with the `base` from step 1:

   ```bash
   agora canvas apply --base r-… --note "把缓存换成 Redis 集群" <<'JSON'
   [{"op": "update_text", "id": "cache", "text": "Redis 集群"}]
   JSON
   ```

4. Read the result. `applied` → tell the person what changed in a sentence or two.
   `stale` → the listed elements changed after your read: read again and redo.
   `invalid` → fix the ops using `errors`. Exit code 3 → no Agora page is open; ask the
   person to open it (`agora open`) instead of editing files.

## Animate an algorithm

Only when asked for an animation or a step-by-step demonstration. Write a script
([animation reference](references/animation.md)) — the initial nodes plus steps — and mount it:
`agora canvas anim <<'JSON' … JSON`. `mounted` → the player appears under the new region.
`invalid` → fix it from `errors` and mount again.

## Replying to a comment

A message that starts with a comment thread is a request about that spot of the diagram
(the anchor ids are given). Make the change, then answer in the comment's language in one
or two sentences — that answer is posted back into the thread.

## Link diagram elements to code (progress pointer)

A box or frame can stand for part of the codebase. Its code paths are globs relative to the
project root; when the session edits a file, Agora moves one pointer onto the element whose glob
matches it (most specific wins) and lists unmatched files as "outside the diagram".

```bash
agora canvas link api 'server/**'                        # element id or its exact label
agora canvas link "Web 前端" 'web/src/**' 'web/index.html'  # adds to what is there
agora canvas link api 'server/api/**' --clear             # replace; --clear alone removes
agora canvas link --json '{"api": ["server/**"], "db": ["db/**", "migrations/*.sql"]}'
```

When the person asks you to link the diagram to the code structure (「按代码结构给架构图关联路径」):

1. `agora canvas read` — note each node's / frame's id, label and any `codePaths` already set.
2. Look at the repository layout (`git ls-files | cut -d/ -f1-2 | sort -u`, or list the top
   directories) and decide which directories or files each element stands for. Prefer whole
   directories (`server/**`); use file globs only where one directory holds several elements.
   Leave elements with no code of their own (users, external services) unlinked.
3. Link them all in one `agora canvas link --json '{…}'` (one undoable change), then tell the
   person which element got which paths and what was left unlinked. `invalid` → an element
   name was ambiguous or unknown: use the ids from step 1.

## Nested canvases (子图): expand a node one level down

A node can open a child canvas — an ordinary canvas one level more detailed (overview → a
service's modules → a module's code logic / call flow). `agora canvas read` shows a node's
`child: {canvasId, name}`, and on a child canvas `canvas.parent` and `canvas.path` (the breadcrumb).

When asked to expand a node (「展开」, 「画出 X 的内部」):

1. `agora canvas child create --parent <canvas> --node <node id or label>` → `created` (a new
   blank canvas named after the node) or `exists` (the node already has one: update that one).
   Either way use the returned `canvas.id` from here on.
2. Read the code the node stands for (its `codePaths`, or find it by the node's name).
3. `agora canvas read --canvas <child id>`, then `apply --canvas <child id>` the inner structure:
   the modules / classes / steps and the calls between them. Keep it one level more detailed
   than the parent — not the whole codebase.
4. Link the child's nodes to their (finer) code with `agora canvas link --canvas <child id> …`,
   so the progress pointer lights them when that code changes.
5. Tell the person in a sentence or two what the child canvas shows.

Also: `agora canvas child list [--parent <canvas>]`, `child link --node N --child <canvas>`
(open an existing canvas from a node; loops are refused), `child unlink --node N` (the child
canvas stays, only the link goes). Animations stay your call: if an algorithm inside a module is
clearer animated, mount one with `agora canvas anim --canvas <child id>`.
