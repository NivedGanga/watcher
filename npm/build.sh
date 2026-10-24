#!/usr/bin/env bash
# Build the PyInstaller binary for the current platform and drop it into
# the matching @agentwatch/<platform>-<arch> package directory.
set -euo pipefail

cd "$(dirname "$0")/.."
CLI=.venv/bin
PY="$CLI/python"

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)  target=darwin-arm64 ;;
  Darwin/x86_64) target=darwin-x64 ;;
  Linux/x86_64)  target=linux-x64 ;;
  Linux/aarch64) target=linux-arm64 ;;
  *) echo "unsupported platform: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

cd cli
if [ ! -x "$PY" ]; then
  python3 -m venv .venv
  "$PY" -m pip install -e . pyinstaller
else
  "$PY" -m pip install -e . pyinstaller --quiet
fi
"$PY" -m PyInstaller --onefile --name agentwatch --paths src \
  --collect-data agentwatch --collect-data certifi --clean -y \
  tools/pyinstaller-entry.py
cd ..

mkdir -p "npm/platforms/$target/bin"
cp "cli/dist/agentwatch" "npm/platforms/$target/bin/agentwatch"
chmod +x "npm/platforms/$target/bin/agentwatch"
echo "built npm/platforms/$target/bin/agentwatch"
