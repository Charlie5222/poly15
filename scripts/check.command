#!/bin/bash
cd "$(dirname "$0")/.."
PORT="${POLY15_PORT:-18790}"
for p in now results model settings chart log; do
  curl -sf -m 8 "http://127.0.0.1:$PORT/api/$p" -o "chk-$p.json" || echo "  $p: no answer"
done
echo saved
echo "Done. You can close this window."
