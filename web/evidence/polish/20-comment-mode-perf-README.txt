Comment mode, before (a946c5b build) vs after, same project/canvas, Ego (Chromium) at 1440x860, DPR 2.
Script: 20-perf-script.mjs. Sequence: press C -> move the pointer over empty canvas, API, MySQL, Web,
Redis, API (41 moves per leg, 8 ms apart) -> click on API (pin set + composer) -> Esc.
Samples: rAF frame intervals and PerformanceObserver('longtask') in the page; CDP Performance.getMetrics
deltas (LayoutCount, RecalcStyleCount, ...). Three alternating runs each: 20-comment-mode-perf-runs.jsonl.

Caveat: the Ego window is not in front, so Chrome throttles it to ~1 frame/s; an active CDP screencast
keeps frames coming (same for both builds), but its cadence sets the frame intervals (8-19 ms median,
varies run to run), so interval "drops" measure the screencast, not the page.

What the runs show:
- Long tasks: 0 in all six runs.
- Layouts: 13 in the before and after runs 2-3 (15 in after run 1, first load) - the aim adds no layout
  while moving (checked separately: 0 layouts across free moves, entering API, moving within it and
  switching to MySQL).
- Max frame interval: before 28-40 ms, after 28-41 ms (screencast-bound, same range).
- Main-thread cost of the aim: +60-80 ms script and +40-60 ms style over ~6 s of continuous pointer
  movement (~0.2 ms per frame): per-frame hit test + two transform writes.
21-aim-spring-trace.txt: the aim pin's position per frame as it springs onto the API node's corner.
