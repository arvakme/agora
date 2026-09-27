---
name: agora-canvas
description: Read and change this project's Agora canvas (Excalidraw architecture diagrams with comment threads) through the `agora canvas` CLI — read the diagram, search the icon/asset library, apply typed edits as one undoable change, mount a step-by-step algorithm animation, or link diagram elements to code paths for Agora's progress pointer. Use when a message comes from Agora or mentions the canvas, diagram, 画布, 架构图, a comment on it, asks to animate/演示 an algorithm, or to link the diagram to code (关联代码路径).
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
