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

# Open the dashboard once the backend API (port 8787) is actually accepting
# connections, then run the server in the foreground so its logs stay visible.
# The backend starts after the shared build and does a network round-trip before
# it listens, so a fixed delay often opened the UI too early — its first API calls
# then hit a not-yet-listening backend and the Vite proxy returned HTTP 500. Poll
# instead, up to ~60s, falling back to opening anyway so we never hang forever.
(
    for _ in $(seq 1 60); do
        # bash's /dev/tcp probe — succeeds only once something is listening on 8787.
        if (exec 3<>/dev/tcp/127.0.0.1/8787) 2>/dev/null; then
            exec 3>&- 3<&-
            break
        fi
        sleep 1
    done
    open http://localhost:5173
) &
npm run dev
