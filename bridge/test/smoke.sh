#!/bin/sh
# Smoke test: spawn the bridge against a throwaway adapter dir and drive it
# like the daemon does (startup, state, models, configure, history, submit).
# Usage: smoke.sh [--submit]   (--submit also runs a real devin prompt; costs ACUs)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER="$(mktemp -d /tmp/bridge-adapter.XXXXXX)"
chmod 700 "$ADAPTER"
export SESAME_PI_ADAPTER_DIR="$ADAPTER"

node "$DIR/../devin-pi-bridge.mjs" -e /nonexistent.ts >"$ADAPTER/pane.log" 2>&1 &
BPID=$!
trap 'kill $BPID 2>/dev/null; rm -rf "$ADAPTER"' EXIT

node "$DIR/link-client.mjs" "$ADAPTER/control.sock" "$@"
echo "--- pane ---"; cat "$ADAPTER/pane.log"
