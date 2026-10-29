#!/bin/bash
# Double-click to restart Poly15 on the current code.
# Stops the running copy, then launches the app again.
cd "$(dirname "$0")/.."
APP="$(pwd)/Poly15.app"

echo "Stopping any running Poly15..."
# The node server inside the bundle, and the launcher shell that waits on it.
pkill -f "Poly15.app/Contents/Resources/app/server.js" 2>/dev/null
pkill -f "Poly15.app/Contents/MacOS/Poly15" 2>/dev/null
sleep 1

# Free the port if something still holds it.
PORT="${POLY15_PORT:-18790}"
PIDS="$(lsof -ti tcp:$PORT 2>/dev/null)"
if [ -n "$PIDS" ]; then
  echo "Releasing port $PORT (pids: $PIDS)"
  kill $PIDS 2>/dev/null
  sleep 1
fi

if curl -sf -m 2 "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1; then
  echo "WARNING: something is still answering on port $PORT."
else
  echo "Port $PORT is free."
fi

echo "Launching Poly15..."
open "$APP"
sleep 4

if curl -sf -m 3 "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1; then
  echo
  echo "Running. Current state:"
  curl -sf -m 3 "http://127.0.0.1:$PORT/api/settings" | head -c 600
  echo
else
  echo "Did not come up. Check ~/Library/Logs/Poly15.log"
fi
echo
echo "Done. You can close this window."
