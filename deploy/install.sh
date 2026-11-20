#!/usr/bin/env bash
# Stage a release on Ubuntu. Does not start/restart the service or touch a firewall.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
release=$(realpath "${1:?Usage: sudo bash deploy/install.sh /opt/labstrata/releases/COMMIT}")
[[ "$release" =~ ^/opt/labstrata/releases/[0-9a-f]{40}$ ]] || { echo 'Use a release directory named with its full commit SHA.' >&2; exit 1; }
[[ -f "$release/server.js" && -f "$release/package-lock.json" ]] || { echo 'Release files are missing.' >&2; exit 1; }
[[ -x /usr/local/bin/node ]] || { echo 'Install Node 22+ at /usr/local/bin/node first; see deploy/README.md.' >&2; exit 1; }
/usr/local/bin/node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)'
getent passwd labstrata >/dev/null || useradd --system --user-group --home-dir /var/lib/labstrata --shell /usr/sbin/nologin labstrata
install -d -m 0700 -o labstrata -g labstrata /var/lib/labstrata
install -d -m 0755 /etc/labstrata
install -d -m 0700 /etc/credstore.encrypted
cd "$release"
# npm lifecycle scripts are unnecessary for this application.
PATH=/usr/local/bin:$PATH npm ci --omit=dev --ignore-scripts --no-audit --no-fund
PATH=/usr/local/bin:$PATH npm test
install -m 0644 deploy/labstrata.service /etc/systemd/system/labstrata.service
if [[ ! -f /etc/labstrata/runtime.env ]]; then
  install -m 0644 deploy/runtime.env.example /etc/labstrata/runtime.env
fi
systemctl daemon-reload
echo 'Release staged. Configure bucket and encrypted credentials, then activate as documented.'
