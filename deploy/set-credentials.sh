#!/usr/bin/env bash
# Run interactively on the Linode. Never pass a key as an argument or enable shell tracing.
set -euo pipefail
set +x
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
install -d -m 0700 /etc/credstore.encrypted
umask 077
for pair in 'AKAMAI_API_KEY:labstrata-inference' 'OBJ_ACCESS_KEY:labstrata-obj-access' 'OBJ_SECRET_KEY:labstrata-obj-secret'; do
  name=${pair%%:*}
  file=${pair#*:}
  systemd-ask-password "Enter $name (hidden):" | systemd-creds encrypt --name="$name" - "/etc/credstore.encrypted/$file"
done
echo 'Encrypted credentials stored. Restart the service after activating a release.'
