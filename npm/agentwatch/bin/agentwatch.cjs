#!/usr/bin/env node
// Resolves the platform-specific @agentwatch-tool/* optional dependency and
// execs the bundled binary with identical stdio (pty passthrough included).
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');

const id = `@agentwatch-tool/${process.platform}-${process.arch}`;
const req = createRequire(__filename);

let binPath;
try {
  const pkgDir = path.dirname(req.resolve(`${id}/package.json`));
  binPath = path.join(pkgDir, 'bin', 'agentwatch');
} catch {
  console.error(
    `agentwatch: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64.\n` +
      `If your platform is supported, reinstall with optional deps: npm i agentwatch --include=optional`,
  );
  process.exit(1);
}

const res = spawnSync(binPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});

if (res.error) {
  console.error(`agentwatch: failed to launch binary: ${res.error.message}`);
  process.exit(1);
}
if (res.signal) {
  // Re-raise so the caller sees the same termination signal.
  process.kill(process.pid, res.signal);
}
process.exit(res.status === null ? 1 : res.status);
