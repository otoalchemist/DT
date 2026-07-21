#!/bin/bash
# macOS launcher — the double-clickable equivalent of start.bat (Windows).
# Finder runs .command files in Terminal on double-click. Mirrors start.bat:
# install deps on first run, free the dev ports, start the dev server, open the UI.
cd "$(dirname "$0")" || exit 1

# Install dependencies on first run (or after a clean clone)
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies, this may take a minute..."
    if ! npm install; then
        echo
        echo "ERROR: npm install failed. Make sure Node.js 20+ is installed."
        echo "Download it from https://nodejs.org"
        read -r -p "Press Return to close..."
        exit 1
    fi
fi

# Free ports used by a previous run (ignore if nothing is listening)
lsof -ti tcp:5173 2>/dev/null | xargs kill -9 2>/dev/null
lsof -ti tcp:8787 2>/dev/null | xargs kill -9 2>/dev/null

# Open the dashboard once the dev server has had a moment to come up, then run
# the server in the foreground so its logs stay visible in this window.
( sleep 6; open http://localhost:5173 ) &
npm run dev
