#!/usr/bin/env bash
# Publish all snitch-tool-* platform packages that contain a built binary,
# then the `snitch-tool` launcher. Run `npm login` first.
set -euo pipefail
cd "$(dirname "$0")"

published=0
for p in platforms/*/; do
  if [ -f "$p/bin/snitch" ] || [ -f "$p/bin/snitch.exe" ]; then
    echo "publishing $p"
    npm publish "$p" --access public
    published=$((published + 1))
  else
    echo "skipping $p (no binary — build on that platform or use CI)"
  fi
done

if [ "$published" -eq 0 ]; then
  echo "no platform binaries present; not publishing launcher" >&2
  exit 1
fi

echo "publishing snitch-tool (launcher)"
npm publish ./snitch --access public
echo "done"
