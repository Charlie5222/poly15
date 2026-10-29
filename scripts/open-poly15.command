#!/bin/bash
# Double-click to open the Poly15 window.
# Poly15 keeps running in the background; this just brings up a window for it.
cd "$(dirname "$0")/.."
PORT="${POLY15_PORT:-18790}"

if ! curl -sf -m 3 "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1; then
  echo "Poly15 is not running. Starting it..."
  open "$(pwd)/Poly15.app"
  for _ in $(seq 1 30); do
    curl -sf -m 1 "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

if ! curl -sf -m 3 "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1; then
  echo "Could not reach Poly15 on port $PORT. See ~/Library/Logs/Poly15.log"
  echo "Done. You can close this window."
  exit 1
fi

echo "Opening the Poly15 window..."
opened=0
for b in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [ -d "/Applications/$b.app" ]; then
    open -na "$b" --args --app="http://127.0.0.1:$PORT" \
      --user-data-dir="$HOME/Library/Application Support/Poly15/chrome" \
      --window-size=900,760 && opened=1 && break
  fi
done
[ "$opened" = 0 ] && open "http://127.0.0.1:$PORT"

echo "Done. You can close this window."
