#!/usr/bin/env bash
# Publish all @agentwatch/* platform packages that contain a built binary,
# then the `agentwatch` launcher. Run `npm login` first.
set -euo pipefail
cd "$(dirname "$0")"

published=0
for p in platforms/*/; do
  if [ -f "$p/bin/agentwatch" ]; then
    echo "publishing $p"
    npm publish "$p" --access public
    published=$((published + 1))
  else
    echo "skipping $p (no binary — run build.sh on that platform or CI)"
  fi
done

if [ "$published" -eq 0 ]; then
  echo "no platform binaries present; not publishing launcher" >&2
  exit 1
fi

echo "publishing agentwatch (launcher)"
npm publish agentwatch --access public
echo "done"
