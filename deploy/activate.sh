#!/usr/bin/env bash
# Explicit activation with readiness check and rollback to the previous release.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
sha=${1:?Usage: sudo bash deploy/activate.sh FULL_COMMIT_SHA}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA.' >&2; exit 1; }
release="/opt/labstrata/releases/$sha"
[[ -f "$release/server.js" && -d "$release/node_modules" ]] || { echo 'Stage this release first.' >&2; exit 1; }
for file in labstrata-inference labstrata-obj-access labstrata-obj-secret; do
  [[ -s "/etc/credstore.encrypted/$file" ]] || { echo 'Configure encrypted credentials first.' >&2; exit 1; }
done
previous=$(readlink -f /opt/labstrata/current || true)
ln -sfn "$release" /opt/labstrata/current.next
mv -Tf /opt/labstrata/current.next /opt/labstrata/current
healthy=false
if systemctl restart labstrata; then
  for attempt in {1..20}; do
    if curl --silent --fail http://127.0.0.1:3000/ready >/dev/null; then healthy=true; break; fi
    sleep 1
  done
fi
if [[ "$healthy" == true ]]; then
  systemctl enable labstrata
  echo "Activated $sha. Run the live smoke test through your SSH tunnel next."
else
  if [[ "$previous" == /opt/labstrata/releases/* && -f "$previous/server.js" ]]; then
    ln -sfn "$previous" /opt/labstrata/current.next
    mv -Tf /opt/labstrata/current.next /opt/labstrata/current
    systemctl restart labstrata
    echo 'Readiness failed; restored the previous release.' >&2
  else
    systemctl stop labstrata
    echo 'Readiness failed; no previous release to restore. Service stopped.' >&2
  fi
  exit 1
fi
