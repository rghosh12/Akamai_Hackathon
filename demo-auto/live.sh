#!/usr/bin/env bash
# Live 4 PM demo: same beats, headed Chrome, no recording. If a live inference call fails (429/timeout),
# the app returns its labelled cached result / STALE badge and the caption says so.
set -euo pipefail
cd "$(dirname "$0")/.."
LIVE=1 BEAT_PAUSE_MS=${BEAT_PAUSE_MS:-2500} node demo-auto/run-demo.mjs
