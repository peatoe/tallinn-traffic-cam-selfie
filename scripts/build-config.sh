#!/usr/bin/env sh
# Generates app/config.js (gitignored) with runtime config for the app.
# Key source: $STADIA_API_KEY env var, else .env in the repo root.
# Run from anywhere: sh scripts/build-config.sh
set -eu
cd "$(dirname "$0")/.."

if [ "${STADIA_API_KEY:-}" = "" ] && [ -f .env ]; then
  STADIA_API_KEY=$(grep -E '^STADIA_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d ' "')
fi
: "${STADIA_API_KEY:=}"

printf 'window.APP_CONFIG = { stadiaApiKey: "%s" };\n' "$STADIA_API_KEY" > app/config.js
if [ -n "$STADIA_API_KEY" ]; then
  echo "wrote app/config.js (with API key)"
else
  echo "wrote app/config.js (no key: localhost is keyless, prod falls back to OSM)"
fi
