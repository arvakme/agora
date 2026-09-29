---
name: agora
description: Everything an agent does in Agora, a project's architecture-canvas workbench, via the `agora` CLI — read/edit the canvas diagram (画布, 架构图), animate an algorithm (动画演示), link diagram nodes to code paths (关联代码), expand a node into a child canvas (子图/展开), answer a canvas comment (评论), and hand work to another agent (派活给另一个 agent) or return a receipt with `agora reply` when a task carries a `dispatch=` marker. Use when a message comes from Agora or mentions any of these.
---

# Agora

Agora keeps the project's canvas in `.agora/`. Never edit those files: use `agora canvas …`
(one JSON object out). `agora` is on PATH in sessions Agora starts; elsewhere run
`scripts/agora` from this skill's directory. Canvas and session default to `$AGORA_CANVAS` /
`$AGORA_SESSION`; with several canvases pass `--canvas <id|name>` (`agora canvas list`).

Exit codes: 0 ok · 1 refused (`invalid` / `stale` / error: read the JSON) · 2 bad usage ·
3 no Agora page/server: ask the person to run `agora open`; never edit files instead.
`read`, `list`, `search`, `schema`, `child list` work without a page; `apply`, `anim`, `link`,
`child create|link|unlink` need the open page.

## Edit the diagram — [references/canvas-ops.md](references/canvas-ops.md)

1. `agora canvas read` → `scene` and `base`. 
2. Only when the request names a product, technology or icon: `agora canvas search redis`
   (1–3 English keywords), use an item `id`. Plain boxes are `add_shape`.
3. Smallest set of ops, then `agora canvas apply --base <base> --note "…" <<'JSON' [ops] JSON`.
4. `applied` → say what changed in a sentence or two. `stale` → read again and redo.
   `invalid` → fix from `errors`.

## Animate an algorithm — [references/animation.md](references/animation.md)

Only when asked. `agora canvas anim <<'JSON' {script} JSON`; `mounted` or fix from `errors`.

## Answer a comment — [references/comments.md](references/comments.md)

A message starting with a comment thread is about that spot: act, then reply briefly.

## Link nodes to code — [references/link.md](references/link.md)

`agora canvas link <element> 'server/**'`: the progress pointer follows edited files onto nodes.

## Expand a node into a child canvas — [references/nested.md](references/nested.md)

`agora canvas child create --parent <canvas> --node <node>`, then draw the next level.

## Dispatch work to another agent — [references/dispatch.md](references/dispatch.md)

`agora dispatch --to <session>|--new claude|codex|pi --text "…"` hands a task to another session, then
`agora dispatch wait <id>`; a task marked `dispatch=` is answered with
`agora reply --request <id> --status done|failed|blocked --text "…"`.
