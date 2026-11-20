#!/usr/bin/env bash
# Reset to the demo state: reseed Postgres (SOP + ~40 past findings), node B back to CHECKER_FAULT=0,
# wait until the NodeBalancer shows both nodes UP. Sealed records stay locked; every run gets a fresh ID.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=infra/keys/id_ed25519
KH=infra/keys/known_hosts
A_IP=$(node -p "require('./infra/state.json').nodes.a.publicIp")

echo "• reseeding Postgres from node A (DB is VPC-only)"
ssh -i "$KEY" -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=accept-new root@"$A_IP" \
  "cd /opt/labstrata/app && sudo -u labstrata bash -c 'set -a; . /etc/labstrata/env; node infra/seed.js'"

echo "• node B back to prompt v1"
node infra/provision.mjs fault off

echo "• waiting for NodeBalancer: both nodes UP"
for i in $(seq 1 60); do
  OUT=$(node infra/provision.mjs status 2>/dev/null | grep '^config' | head -1 || true)
  echo "   $OUT"
  if echo "$OUT" | grep -q 'node-a=UP' && echo "$OUT" | grep -q 'node-b=UP'; then echo "READY"; exit 0; fi
  sleep 5
done
echo "NodeBalancer did not show both nodes UP" >&2; exit 1
