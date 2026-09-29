Recorded 2026-09-29 from `pi --mode rpc` 0.87.1 (system prompt and extension status lines cut): a `prompt`, an `abort` while it
runs (ends `stopReason: aborted`, then `agent_end`, `agent_settled`), and a second `prompt` on the same process.
`tests/fake_pi_rpc.py` speaks the same shapes; `PiStream` reads them, the same events as `pi -p --mode json`.
