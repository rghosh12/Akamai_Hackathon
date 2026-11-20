# infra (Lane A)

All provisioning is `node infra/provision.mjs <step>` (Linode API v4 + S3 API; no linode-cli/aws-cli needed).
Put `LINODE_TOKEN` (and `AKAMAI_API_KEY`) in the git-ignored `.env` first. State goes to `infra/state.json`, SSH key to `infra/keys/` (both git-ignored).

Order (gates first, fast-mode fallbacks in brackets):

```bash
node infra/provision.mjs gate-inference   # GATE 1: qwen + gemma image + embeddings
node infra/provision.mjs keys             # Object Storage key -> .env
node infra/provision.mjs buckets          # capture bucket + CORS, lock bucket (COMPLIANCE 1 day) [-> versioning]
node infra/provision.mjs gate-lock        # GATE 2: version delete -> AccessDenied
node infra/provision.mjs gate-presign     # GATE 3: presigned PUT (then test /capture/<id> on a real phone)
node infra/provision.mjs vpc
node infra/provision.mjs db               # ~10 min; private VPC only
node infra/provision.mjs firewall         # 80 from 192.168.255.0/24 (NodeBalancer), 22 from MY_IPS
node infra/provision.mjs linodes          # 2x g6-standard-1, Ubuntu 24.04, VPC 10.0.0.11/.12
node infra/provision.mjs db-wait          # DATABASE_URL (private host) -> .env
node infra/provision.mjs deploy           # GATE 4: node /calibration over VPC DB; systemd service
node infra/provision.mjs nodebalancer     # health check: HTTP body /calibration ^(CALIBRATED|STALE)
node infra/provision.mjs https            # Let's Encrypt for the NodeBalancer hostname -> 443 config
node infra/provision.mjs deploy           # pick up PUBLIC_URL
ssh -i infra/keys/id_ed25519 root@<nodeA> "cd /opt/labstrata/app && sudo -u labstrata bash -c 'set -a; . /etc/labstrata/env; node infra/seed.js'"
node infra/provision.mjs status
```

Demo toggle: `node infra/provision.mjs fault on|off` (node B gets prompt v2, fails its exam, NodeBalancer pulls it).
