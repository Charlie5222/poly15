#!/bin/bash
# Double-click to check that the market's "Yes" side really means "Up".
# Read-only, public data only.
cd "$(dirname "$0")/.."
NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.volta/bin/node"; do
  [ -x "$c" ] && { NODE="$c"; break; }
done
[ -z "$NODE" ] && for n in "$HOME/.nvm/versions/node"/*/bin/node; do [ -x "$n" ] && { NODE="$n"; break; }; done
[ -z "$NODE" ] && NODE="$(/bin/bash -lc 'command -v node' 2>/dev/null)"
if [ -z "$NODE" ]; then echo "Node.js not found."; exit 1; fi
"$NODE" tools/verify-yes-is-up.js
echo
echo "Done. You can close this window."
