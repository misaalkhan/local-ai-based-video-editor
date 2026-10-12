#!/bin/bash
# Double-click to start Local Studio and open it in the browser. Close this window to stop it.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. Install it from https://nodejs.org (23.6 or newer), then try again."
  read -r -p "Press return to close."
  exit 1
fi
if [ ! -d node_modules ] || [ ! -f models/ggml-large-v3-turbo-q5_0.bin ]; then
  echo "First run: setting things up (this downloads the speech models once)."
  npm run setup || { read -r -p "Setup failed. Press return to close."; exit 1; }
fi
echo "Starting Local Studio at http://localhost:4747 (close this window to stop)."
npx vite build >/dev/null 2>&1
exec node server/index.ts --open
