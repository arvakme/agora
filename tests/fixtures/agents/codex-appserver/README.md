Recorded 2026-09-29 from `codex app-server` 0.157.1 (raw lines, paths and account notices removed): a turn interrupted with
`turn/interrupt`, a second turn on the same thread, then a NEW process resuming the thread (`thread/resume`) for a third.
`tests/fake_codex_appserver.py` speaks the same shapes; `CodexAppStream` (adapters/codex.py) reads them.
