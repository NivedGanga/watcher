# NOTES — agentwatch CLI

Implementation notes, ambiguities, decisions, deviations, and known gaps.

## Conflicts between the task prompt and spec/ (spec won)

None requiring code changes; see Deviations for judgement calls.

## Ambiguities and decisions

- **Heartbeat interval.** spec/SPEC.md says "every 60 seconds" and marks it
  *default (confirm)*; the prompt specifies every 5 minutes with a
  `heartbeat.interval_minutes` config knob. The prompt's value is treated as
  the user-confirmation the spec asked for: default 5 minutes, configurable.
  5 min still gives 3× margin inside the server's 15-minute silence window.
- **Stall threshold.** Same situation: spec's "60 seconds" is *default
  (confirm)*; the prompt gives `--stall 15m` default plus per-agent `stall`
  in config. The prompt wins; the wire semantics are unchanged.
- **The one-minute tick lives on the server.** Silence detection, email
  fallback, reminders, grouping close-out, auto-off, and the hard cap all run
  in `POST /api/jobs/tick` server-side. The CLI only reports; it has no
  scheduler for those rules.
- **"Question outstanding" vs stall.** SPEC.md suppresses `stalled` while a
  question is outstanding for the run. The CLI tracks this with a
  `question_open_at` column on the runs table: `agentwatch ask` sets it, and
  output observed ≥1s after it was set clears it (the 1s grace covers the
  question prompt itself still sitting in the pty buffer). A question is
  therefore "outstanding" until the agent next prints — an approximation of
  "answered", noted here.
- **Metadata-mode summaries.** Templates (recorded as required):
  `question` → "Question from {agent}", `done` → "Finished: {agent}",
  `failed` → "Failed: {agent}", `timed_out` → "Timed out: {agent}",
  `stalled` → "Stalled: {agent}". `{agent}` is the *redacted* agent name.
- **`started` events.** Never enqueued anywhere; run registration is the
  `runs` table row only.
- **Exit code on signal death.** "Exit with the child's exit code" is
  implemented as 128+signal (shell convention); the event's `exit_code` field
  is null for signal deaths and timeouts since there is no exit status.
- **Backoff.** 5s × 2^attempts with ±50% jitter, capped at 1 hour.
- **`logout` when not logged in.** Prints "Not logged in." and exits 0 (the
  desired end state already holds).
- **Ctrl-C during login** exits 130 with "Login cancelled." and makes no
  network call.
- **`agentwatch test` run_id** is `test-<uuid4>` per invocation; the run_id
  uniqueness also keeps the server's 10-minute dedup from collapsing repeat
  tests into `duplicate` results.
- **Env overrides.** `AGENTWATCH_CONFIG_DIR` and `AGENTWATCH_DATA_DIR`
  override the default paths (used by the test suite; XDG vars are honored
  too). `AGENTWATCH_OUTPUT_SIGNAL_INTERVAL` shortens the 30s output_seen
  throttle for tests.

## Known gaps

- **Idle detection on Wayland** (and X11 sessions without `xprintidle`):
  mode `none` — `input_resumed` signals are disabled and the daemon warns
  once at start. There is no stdlib-friendly Wayland idle protocol; a future
  version could shell out to `swayidle`-style hooks.
- **PID reuse**: `active_runs` counts runs whose PID is alive; a recycled PID
  belonging to another process could be counted until the run row's
  `ended_at` is set or the machine reboots.
- **ioreg parsing** depends on the `HIDIdleTime` key name, which is stable
  but undocumented.
- **Scenario timing** is scaled down in tests (`TIME_SCALE`), preserving the
  ordering and thresholds but not wall-clock fidelity.
- **Question "answered" detection** is output-based (see above); an agent
  that is answered but prints nothing keeps the question open until the run
  ends. Harmless: only affects stall suppression.
