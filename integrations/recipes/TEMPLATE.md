# Recipe: `<agent name>`

<!--
Copy this file to `<agent>.md` and fill in every `<...>`.
One recipe per agent. Verify each fact against the agent's current
documentation before publishing — do not write recipes for agents whose
docs you have not checked. Record the check date below.
-->

- **Agent:** `<name>` `<version or "any">`
- **Docs checked:** `<URL>` on `<YYYY-MM-DD>`
- **Integration level:** wrapper + instructions block (and direct HTTP if the
  agent runs inside user code)

## How the agent is launched

`<the exact command or invocation — e.g. a binary on PATH, npx, a shell
alias, a service unit>`

## Wrap it

```sh
agentwatch run --name <agent-name> -- <launch command>
```

`<any caveats: flags the agent needs to stay non-interactive or interactive,
working-directory requirements, environment it expects>`

## Where its instructions file lives

`<path>` — per `<source URL>` (checked `<YYYY-MM-DD>`).

`<Does the agent read a project-level file, a user-level file, or both?
Does it append or does a marker block fit its conventions?>`

## Install the instructions block

```sh
# If the file already contains the agentwatch markers:
python3 integrations/tools/sync_instructions.py --target <path>

# If it does not (adds the block at the end):
python3 integrations/tools/sync_instructions.py --append --target <path>
```

Verify: `python3 integrations/tools/sync_instructions.py --check --target <path>`
prints `in sync`.

## What this does not cover

`<e.g. approvals inside the agent's own TUI, sub-agents it spawns, runs
started outside the wrapper, anything verified not to work>`

## Verify with a test run

```sh
agentwatch run --name <agent-name> -- <launch command>
```

1. In the agent, ask it to do a task that ends on its own → expect a `done`
   alert.
2. Have the agent run `agentwatch ask "Test question: pick A or B"` →
   expect a `question` alert; answer it at the terminal.
3. Kill the run (`Ctrl-C` or `kill <pid>`) → expect a `failed` alert.
4. `agentwatch run` on a command that sleeps past the stall threshold →
   expect `stalled`.

Expected events match `spec/fixtures/scenarios/`; the conformance harness
in `integrations/conformance/` checks the same list end-to-end.
