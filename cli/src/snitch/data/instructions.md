<!-- snitch:start -->
## Snitch

This machine runs Snitch. It alerts the human — by push notification or
email — when you need a decision or when you finish work they asked for. Two
commands are on PATH (mobile answers require a CLI version with `ask --wait`):

- `snitch ask --wait "<question>" --option "Choice A" --option "Choice B" --allow-text`
  — call when you need a human decision you cannot make yourself. Supply up to
  eight structured options; use `--allow-text` for a custom reply. With no
  options the question accepts text. Questions expire after 30 minutes by
  default; use `--timeout 2h` when needed (maximum 24h).
- Read the JSON tool result and continue only when `status` is `answered`.
  The answer contains an option ID and label, or text. Use the harness's
  supported mechanism to wait for a long-running shell command. If the shell
  tool times out, recover with `snitch wait <question_id>` using the ID
  printed on stderr. Do not issue a new question for a retry.
- `snitch ask "<question>"` only sends an alert; it does not collect an
  answer. Do not use it as a substitute for an answered decision.
- `snitch done "<summary>"` — call when you finish a task the human
  asked for and would want to know is complete. One line.

Do not call either command for routine steps, progress updates, retries,
tool output, or approvals the human has already given.

If `snitch` is missing, unsupported, expires, or fails, the decision is still
unresolved. Continue independent work and ask the human through the harness;
never invent an answer or interpret a failure as approval. Mobile replies do
not bypass harness tool-permission controls.

Never put secrets, tokens, file contents, or customer data in a question or
summary.
<!-- snitch:end -->
