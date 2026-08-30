#!/usr/bin/env bash
# Idempotent bootstrap for Cloud Agents: deps, CLI build, VS Code extension bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci
npm run build
npm run build:extension

# Put `mpx` on PATH for agents and demos (npm link fails when prefix is /).
chmod +x dist/src/cli.js
mkdir -p "${HOME}/.local/bin"
ln -sf "$(pwd)/dist/src/cli.js" "${HOME}/.local/bin/mpx"
export PATH="${HOME}/.local/bin:${PATH}"

echo "multiplayer-cli ready: $(node dist/src/cli.js --version)"
