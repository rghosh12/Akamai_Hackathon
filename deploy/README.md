# Ubuntu Linode deployment

Target: Ubuntu 24.04 LTS, 2 GB Linode. This is a single-process demo with private SSH-tunnel access. No production rollout is triggered by a GitHub push.

## 1. Stage the exact tested commit

Allow TCP 22 in the Linode firewall **only from your current public IP**, with inbound DROP and outbound ACCEPT. Do not expose ports 3000 or 80 for this app. Verify the SSH host fingerprint using the Linode console before accepting it.

On Windows PowerShell, from your repository checkout:

```powershell
$linodeTarget = 'root@YOUR_LINODE_IP'
$releaseSha = git rev-parse HEAD
git archive --format=tar.gz --output="labstrata-$releaseSha.tar.gz" HEAD
scp -i "$HOME\.ssh\labstrata_ed25519" "labstrata-$releaseSha.tar.gz" "${linodeTarget}:/tmp/"
ssh -i "$HOME\.ssh\labstrata_ed25519" $linodeTarget
```

`git archive` includes tracked source only, excluding local `.env`, data, and SSH keys. Do not use `scp -r` on your development folder. The private GitHub repository needs no access token on the Linode when using this archive method.

On Ubuntu, set the full commit SHA printed locally:

```bash
RELEASE_SHA=FULL_40_CHARACTER_COMMIT_SHA
sudo install -d -m 0755 "/opt/labstrata/releases/$RELEASE_SHA"
sudo tar --no-same-owner -xzf "/tmp/labstrata-$RELEASE_SHA.tar.gz" -C "/opt/labstrata/releases/$RELEASE_SHA"
```

Install a supported Node runtime at `/usr/local/bin/node` if it is not already present. For an x86-64 Linode, this pinned Node 24 release matches the development runtime; verify its official checksum before extraction:

```bash
cd /tmp
curl --fail --show-error --location --remote-name https://nodejs.org/download/release/v24.15.0/node-v24.15.0-linux-x64.tar.xz
echo '472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6  node-v24.15.0-linux-x64.tar.xz' | sha256sum --check -
sudo tar -xJf node-v24.15.0-linux-x64.tar.xz -C /usr/local --strip-components=1
node --version
cd "/opt/labstrata/releases/$RELEASE_SHA"
sudo bash deploy/install.sh "$PWD"
```

Check `uname -m` first; use the corresponding official ARM64 build and checksum for an ARM host. [Official release checksums](https://nodejs.org/download/release/v24.15.0/SHASUMS256.txt).

## 2. Configure the private bucket and credentials

Create a **private** Chicago Standard E3 bucket and a bucket-scoped read/write Object Storage key, following the [official workshop](https://github.com/akamai-developers/akamai-workshop-seattle-hackathon/tree/main/04-object-storage). The app uses only `labstrata/evidence/` and `labstrata/checks/`. A storage test uploads, reads, and deletes its unique temporary probe. Evidence packets are retained.

Edit `/etc/labstrata/runtime.env` to set `OBJ_BUCKET` and, if different, the endpoint/model. This file contains **non-secret** settings only. Keep HTTPS enabled for the Akamai endpoints.

In the Linode's interactive terminal:

```bash
sudo bash deploy/set-credentials.sh
```

The script prompts invisibly for each secret and sends it directly to systemd's encrypted credential store. Never put keys in shell arguments, screenshots, GitHub, or the runtime environment file. Systemd decrypts them into a service-private runtime directory; Node reads that directory through `CREDENTIALS_DIRECTORY`. `NODE_ENV=production` disables `.env` loading. For an existing secret manager, supply equivalent `_FILE` mounts instead. [Systemd credential documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#LoadCredentialEncrypted=ID:Path).

Before moving an existing installation, stop its old process and copy its existing `data/` contents to `/var/lib/labstrata/` with ownership `labstrata:labstrata`. Keep a backup. Do not run two Node processes against the same JSON database.

## 3. Activate and verify

The staging script does not start the service. Activate when ready:

```bash
sudo bash deploy/activate.sh "$RELEASE_SHA"
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/ready
sudo systemctl status labstrata --no-pager
```

`/ready` verifies local data access; it does not spend inference tokens or call cloud storage. The service runs as an unprivileged user, binds localhost, persists local data outside releases, has CPU/memory limits, and restarts after a failure.

Back on Windows, keep this tunnel open:

```powershell
ssh -i "$HOME\.ssh\labstrata_ed25519" -N -L 3000:127.0.0.1:3000 $linodeTarget
```

Open `http://127.0.0.1:3000`. In another local terminal:

```bash
npm run smoke:live -- --url http://127.0.0.1:3000
```

This performs a real storage write/read/delete, a real inference call with synthetic text, then evidence save/read-back/reopen. It fails if inference silently falls back. It prints statuses only and retains one synthetic evidence packet in the bucket.

To demonstrate persistence: save an evidence packet in the UI, copy its ID, restart `labstrata`, and reopen by ID. Reopening must preserve the original model request ID and must work without a new inference call. Service operation timestamps reset on restart; that is expected.

## Rollback and troubleshooting

Activation automatically restores the previous release if `/ready` does not succeed. To roll back manually, activate a previously staged commit using the same command:

```bash
sudo bash /opt/labstrata/current/deploy/activate.sh PREVIOUS_FULL_COMMIT_SHA
curl --fail http://127.0.0.1:3000/ready
```

Data lives at `/var/lib/labstrata` and is not removed by rollback. This release does not migrate the existing protocol database format. Keep local data backups and private bucket retention policies appropriate to your demo. The server is a single-user prototype, not a validated laboratory compliance system.

- `configured` means settings exist; `operational` means a successful validated operation occurred during this process. A later cloud failure changes status to `error`.
- Inference 401/403: check the event key; 429: wait for quota/rate recovery. The event key may be revoked after the workshop.
- Object Storage failure: check the Chicago endpoint, bucket spelling, and bucket-scoped read/write permission. No public bucket policy or presigned URL is needed; reads go through the Node server.
- SSH timeout: verify TCP 22 is allowed for your current IP, keeping an existing console/session open while adjusting rules.
- Startup failure: check `journalctl -u labstrata -n 30 --no-pager`, the runtime configuration, Node location, and encrypted credential file permissions. Do not post logs or screenshots containing secrets.
- Stopping the app or deleting objects does not cancel Object Storage billing; see the workshop's [cleanup guide](https://github.com/akamai-developers/akamai-workshop-seattle-hackathon/blob/main/docs/cleanup.md).

Public access requires authentication and HTTPS before changing the localhost binding or firewall. No public exposure is part of this deployment preparation.
