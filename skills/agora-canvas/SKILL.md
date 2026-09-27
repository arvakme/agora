---
name: agora-canvas
description: Read and change this project's Agora canvas (Excalidraw architecture diagrams with comment threads) through the `agora canvas` CLI — read the diagram, search the icon/asset library, apply typed edits as one undoable change, or mount a step-by-step algorithm animation. Use when a message comes from Agora or mentions the canvas, diagram, 画布, 架构图, a comment on it, or asks to animate/演示 an algorithm.
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
