#!/bin/bash
# make-app.command — builds Poly15.app next to this file.
# Double-click this once. After that, launch Poly15.app like any other app.
set -euo pipefail
cd "$(dirname "$0")"

APP="Poly15.app"
echo "Building $APP in $(pwd)"

for f in us.js server.js ui.html; do
  [ -f "$f" ] || { echo "ERROR: missing $f. Keep all the files in one folder."; read -r -p "Press return." _ || true; exit 1; }
done

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

cp us.js server.js ui.html "$APP/Contents/Resources/app/"
for opt in lib.js strategies.js selftest.js; do [ -f "$opt" ] && cp "$opt" "$APP/Contents/Resources/app/"; done
[ -f record.js ]  && cp record.js  "$APP/Contents/Resources/app/"
[ -f analyze.js ] && cp analyze.js "$APP/Contents/Resources/app/"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Poly15</string>
  <key>CFBundleDisplayName</key><string>Poly15</string>
  <key>CFBundleIdentifier</key><string>local.poly15.app</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Poly15</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

cat > "$APP/Contents/MacOS/Poly15" <<'LAUNCH'
#!/bin/bash
# Launcher. A double-clicked app gets a bare PATH, so locate node explicitly.
HERE="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
PORT="${POLY15_PORT:-18790}"
# Keep recordings OUTSIDE the bundle so rebuilding the app never loses data.
export POLY15_DATA="${POLY15_DATA:-$HOME/Library/Application Support/Poly15/data}"
mkdir -p "$POLY15_DATA"
LOG="$HOME/Library/Logs/Poly15.log"
mkdir -p "$(dirname "$LOG")"

find_node() {
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
           "$HOME/.volta/bin/node" "$HOME/.local/bin/node"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  for nvm in "$HOME/.nvm/versions/node"/*/bin/node; do
    [ -x "$nvm" ] && { echo "$nvm"; return; }
  done
  command -v node 2>/dev/null && return
  # Last resort: a login shell knows about version managers.
  /bin/bash -lc 'command -v node' 2>/dev/null
}

NODE="$(find_node || true)"
if [ -z "$NODE" ]; then
  osascript -e 'display dialog "Poly15 needs Node.js, and could not find it.\n\nInstall it from nodejs.org (the LTS build), then open Poly15 again." buttons {"OK"} default button 1 with title "Poly15" with icon caution' >/dev/null 2>&1
  exit 1
fi

# If an instance is already serving this port, just show its window.
if curl -s -m 2 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT"
  exit 0
fi

cd "$HERE"
echo "=== $(date) launching with $NODE ===" >> "$LOG"
PORT="$PORT" POLY15_DATA="$POLY15_DATA" "$NODE" server.js >> "$LOG" 2>&1 &
SERVER_PID=$!

# Wait for it to answer before opening a window.
for _ in $(seq 1 40); do
  curl -s -m 1 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || {
    osascript -e "display dialog \"Poly15 could not start.\n\nLog: ~/Library/Logs/Poly15.log\" buttons {\"OK\"} default button 1 with title \"Poly15\" with icon stop" >/dev/null 2>&1
    exit 1
  }
  sleep 0.25
done

# Prefer a chromeless window so it reads as an app, not a browser tab.
opened=0
for b in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [ -d "/Applications/$b.app" ]; then
    open -na "$b" --args --app="http://127.0.0.1:$PORT" \
      --user-data-dir="$HOME/Library/Application Support/Poly15/chrome" && opened=1 && break
  fi
done
[ "$opened" = 0 ] && open "http://127.0.0.1:$PORT"

# Keep the app alive while the server runs, so it shows in the Dock and
# quitting it stops the recorder.
wait "$SERVER_PID"
LAUNCH

chmod +x "$APP/Contents/MacOS/Poly15"
# Clear the quarantine flag so Gatekeeper does not block a locally built app.
xattr -cr "$APP" 2>/dev/null || true

echo
echo "Done. $APP is in this folder."
echo "Recordings are saved to: ~/Library/Application Support/Poly15/data"
echo "Drag it to /Applications if you like, then double-click to run."
echo
read -r -p "Press return to close." _ || true
