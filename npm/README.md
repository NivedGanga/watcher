# agentwatch

Wrap any terminal agent or script — get a push notification or email when it
finishes, fails, gets stuck, or needs a decision.

```sh
npm i -g agentwatch-tool          # or: npx agentwatch-tool <command>
agentwatch login             # approve in the browser PWA
agentwatch daemon            # background delivery (or: agentwatch install-service)
agentwatch run --name demo -- python3 train.py
```

Inside any agent (Claude Code, Devin, scripts), two commands report back:

```sh
agentwatch ask "Deploy to prod or staging?"   # blocking question → your phone
agentwatch done "Migrated 42 models."          # completion → your phone
```

Events queue locally when offline and flush on reconnect. Privacy modes keep
prompts/summaries on-device (`metadata` sends only fixed labels).

Requires an AgentWatch backend (self-hosted or hosted) — see
https://github.com/NivedGanga/watcher

## How it works

This package ships a tiny launcher plus a prebuilt binary for your platform
(`@agentwatch-tool/darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`),
installed automatically via npm `optionalDependencies`.
