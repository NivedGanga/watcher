<!-- agentwatch:start -->
## AgentWatch

This machine runs AgentWatch. It alerts the human — by push notification or
email — when you need a decision or when you finish work they asked for. Two
commands are on PATH:

- `agentwatch ask "<question>"` — call when you need a human decision you
  cannot make yourself. Keep the question specific and under 200 characters;
  list the options when there are two or three.
- `agentwatch done "<summary>"` — call when you finish a task the human
  asked for and would want to know is complete. One line.

Do not call either command for routine steps, progress updates, retries,
tool output, or approvals the human has already given.

If `agentwatch` is missing or a call fails, keep working and do not mention
it unless asked.

Never put secrets, tokens, file contents, or customer data in a question or
summary.
<!-- agentwatch:end -->
