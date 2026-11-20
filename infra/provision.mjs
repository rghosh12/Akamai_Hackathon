#!/usr/bin/env node
// LabStrata infra on Akamai Cloud, driven by the Linode API v4 + the S3 API. Node 18+, no CLIs needed.
//   node infra/provision.mjs <step> [...]
// Steps (run in this order; each is idempotent via infra/state.json):
//   gate-inference   one qwen call + one gemma image call
//   keys             create an Object Storage access key (us-ord), prints S3_* lines for .env
//   buckets          capture bucket (+CORS) and Object Lock bucket (COMPLIANCE, 1 day)
//   gate-lock        put a locked object, delete its version -> expect AccessDenied
//   gate-presign     presigned PUT round trip (same path the phone uses)
//   vpc              VPC + subnet in us-sea
//   db               Managed PostgreSQL in us-sea on the VPC, private only (~10 min to provision)
//   db-wait          wait for the DB and print DATABASE_URL (+ writes infra/keys/db-ca.crt)
//   firewall         Cloud Firewall: 80 only from NodeBalancer 192.168.255.0/24, 22 from MY_IPS
//   linodes          two shared 2 GB Linodes (Ubuntu 24.04) on the VPC, behind the firewall
//   deploy [a|b]     ssh: install Node, clone the branch, write /etc/labstrata/env, systemd service
//   nodebalancer     NodeBalancer, health check = HTTP body regex on /calibration ^(CALIBRATED|STALE)
//   https            Let's Encrypt cert for the NodeBalancer hostname, then add a 443 config
//   fault <on|off>   toggle CHECKER_FAULT on node B (prompt v2) and restart it
//   status           print everything + NodeBalancer node health
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'infra', 'state.json');
const KEYS = path.join(ROOT, 'infra', 'keys');
loadEnv(path.join(ROOT, '.env'));

const REGION = process.env.LINODE_REGION || 'us-sea';
const S3_REGION = process.env.S3_REGION || 'us-ord-1';
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'https://us-ord-1.linodeobjects.com';
const BRANCH = process.env.DEPLOY_BRANCH || 'jonathan-cloud';
const REPO = process.env.DEPLOY_REPO || 'https://github.com/rghosh12/Akamai_Hackathon.git';
const PREFIX = process.env.INFRA_PREFIX || 'labstrata';
const NB_RANGE = '192.168.255.0/24';

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const save = () => { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); };
const log = (...a) => console.log('•', ...a);
const ok = (...a) => console.log('\x1b[32mPASS\x1b[0m', ...a);
const fail = (...a) => console.log('\x1b[31mFAIL\x1b[0m', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function setEnv(pairs) {
  // Writes/updates keys in the git-ignored .env
  const file = path.join(ROOT, '.env');
  let txt = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [k, v] of Object.entries(pairs)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    txt = re.test(txt) ? txt.replace(re, `${k}=${v}`) : txt.replace(/\n?$/, `\n${k}=${v}\n`);
    process.env[k] = String(v);
  }
  fs.writeFileSync(file, txt);
  log('updated .env:', Object.keys(pairs).join(', '));
}

// ---------- Linode API ----------
async function api(method, p, body) {
  const token = process.env.LINODE_TOKEN;
  if (!token) throw new Error('LINODE_TOKEN missing in .env');
  const r = await fetch('https://api.linode.com/v4' + p, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${t.slice(0, 600)}`);
  return t ? JSON.parse(t) : {};
}
const findByLabel = async (p, label) => (await api('GET', p + '?page_size=500')).data.find(x => x.label === label);

// ---------- S3 ----------
async function s3() {
  const S = await import('@aws-sdk/client-s3');
  const client = new S.S3Client({
    endpoint: S3_ENDPOINT, region: S3_REGION,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { S, client };
}
const md5 = b => crypto.createHash('md5').update(b).digest('base64');

// ---------- SSH ----------
function sshKey() {
  fs.mkdirSync(KEYS, { recursive: true });
  const k = path.join(KEYS, 'id_ed25519');
  if (!fs.existsSync(k)) execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'labstrata-infra', '-f', k], { stdio: 'inherit' });
  return { priv: k, pub: fs.readFileSync(k + '.pub', 'utf8').trim() };
}
function ssh(ip, cmd, input) {
  ip = (JSON.parse(process.env.SSH_ALT || '{}'))[ip] || ip; // optional IPv4->IPv6 override when on a changing carrier IP
  return execFileSync('ssh', ['-i', sshKey().priv, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(KEYS, 'known_hosts'), '-o', 'ConnectTimeout=15', `root@${ip}`, cmd],
    { input, encoding: 'utf8', stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'], maxBuffer: 50e6 });
}

// =====================================================================
const steps = {
  async 'gate-inference'() {
    const base = (process.env.AKAMAI_BASE_URL || 'https://api.akamai-inference.com/v1').replace(/\/+$/, '');
    const h = { Authorization: 'Bearer ' + process.env.AKAMAI_API_KEY, 'Content-Type': 'application/json' };
    const t0 = Date.now();
    let r = await fetch(base + '/chat/completions', { method: 'POST', headers: h, body: JSON.stringify({ model: process.env.AKAMAI_MODEL || 'qwen3-8-27b', temperature: 0, max_tokens: 50, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }) });
    let t = await r.text();
    r.ok ? ok(`qwen ${r.status} in ${Date.now() - t0} ms:`, JSON.parse(t).choices?.[0]?.message?.content?.slice(0, 80)) : fail('qwen', r.status, t.slice(0, 300));
    // 8x8 red PNG as a base64 data URL (remote URLs return 422)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';
    const t1 = Date.now();
    r = await fetch(base + '/chat/completions', { method: 'POST', headers: h, body: JSON.stringify({ model: process.env.AKAMAI_VISION_MODEL || 'gemma-4-26b-a4b-it', temperature: 0, max_tokens: 50,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What colour is this image? One word.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] }] }) });
    t = await r.text();
    r.ok ? ok(`gemma ${r.status} in ${Date.now() - t1} ms:`, JSON.parse(t).choices?.[0]?.message?.content?.slice(0, 80)) : fail('gemma', r.status, t.slice(0, 300));
    r = await fetch(base + '/embeddings', { method: 'POST', headers: h, body: JSON.stringify({ model: process.env.AKAMAI_EMBED_MODEL || 'qwen3-embedding-8b', input: ['Step 4 balance the rotor'] }) });
    t = await r.text();
    r.ok ? ok('embeddings dim', JSON.parse(t).data?.[0]?.embedding?.length) : fail('embeddings', r.status, t.slice(0, 300));
  },

  async keys() {
    if (process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY) return log('S3 keys already in .env');
    const k = await api('POST', '/object-storage/keys', { label: `${PREFIX}-app` });
    setEnv({ S3_ACCESS_KEY: k.access_key, S3_SECRET_KEY: k.secret_key, S3_ENDPOINT, S3_REGION });
    state.s3KeyId = k.id; save();
  },

  async buckets() {
    const { S, client } = await s3();
    const capture = process.env.S3_CAPTURE_BUCKET || `${PREFIX}-capture-${crypto.randomBytes(3).toString('hex')}`;
    const lock = process.env.S3_LOCK_BUCKET || `${PREFIX}-records-${crypto.randomBytes(3).toString('hex')}`;
    const create = async (Bucket, extra = {}) => {
      try { await client.send(new S.CreateBucketCommand({ Bucket, ...extra })); log('created bucket', Bucket); }
      catch (e) { if (!/BucketAlreadyOwnedByYou/.test(e.name)) throw e; log('bucket exists', Bucket); }
    };
    await create(capture);
    const origins = (process.env.CORS_ORIGINS || '*').split(',');
    await client.send(new S.PutBucketCorsCommand({ Bucket: capture, CORSConfiguration: { CORSRules: [{
      AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedOrigins: origins, AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3000 }] } }));
    ok('capture bucket CORS set for', origins.join(','));
    let mode = 'compliance';
    try {
      await create(lock, { ObjectLockEnabledForBucket: true });
      await client.send(new S.PutObjectLockConfigurationCommand({ Bucket: lock, ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 1 } } } }));
      ok('Object Lock bucket (COMPLIANCE, 1 day default):', lock);
    } catch (e) {
      fail('Object Lock not available:', e.name, e.message, '-> falling back to versioning + SHA-256 manifest');
      mode = 'versioning';
      await create(lock);
      await client.send(new S.PutBucketVersioningCommand({ Bucket: lock, VersioningConfiguration: { Status: 'Enabled' } }));
    }
    setEnv({ S3_CAPTURE_BUCKET: capture, S3_LOCK_BUCKET: lock, S3_LOCK_MODE: mode });
  },

  async 'gate-lock'() {
    const { S, client } = await s3();
    const Bucket = process.env.S3_LOCK_BUCKET, Key = `gate/lock-test-${Date.now()}.txt`;
    const Body = Buffer.from('LabStrata lock gate ' + new Date().toISOString());
    const put = await client.send(new S.PutObjectCommand({ Bucket, Key, Body, ContentMD5: md5(Body),
      ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(Date.now() + 864e5) }));
    log('put', Key, 'versionId', put.VersionId);
    try {
      await client.send(new S.DeleteObjectCommand({ Bucket, Key, VersionId: put.VersionId }));
      fail('version delete SUCCEEDED: bucket is not locked. Set S3_LOCK_MODE=versioning and say so in Known limits.');
    } catch (e) {
      e.name === 'AccessDenied' || e.$metadata?.httpStatusCode === 403 ? ok('version delete ->', e.name, e.$metadata?.httpStatusCode) : fail('unexpected', e.name, e.message);
    }
  },

  async 'gate-presign'() {
    const { S, client } = await s3();
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const Key = `gate/presign-${Date.now()}.jpg`;
    const url = await getSignedUrl(client, new S.PutObjectCommand({ Bucket: process.env.S3_CAPTURE_BUCKET, Key, ContentType: 'image/jpeg' }), { expiresIn: 600, signableHeaders: new Set(['content-type', 'host']) });
    const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    log('CORS preflight', pre.status, pre.headers.get('access-control-allow-origin'));
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    r.ok ? ok('presigned PUT', r.status) : fail('presigned PUT', r.status, (await r.text()).slice(0, 300));
    console.log('\nPhone test: open this on a real phone is done via /capture/<assignmentId> once the app is up.');
  },

  async vpc() {
    if (state.vpc) return log('vpc exists', state.vpc.id);
    const v = await api('POST', '/vpcs', { label: `${PREFIX}-vpc`, region: REGION, subnets: [{ label: `${PREFIX}-subnet`, ipv4: '10.0.0.0/24' }] });
    state.vpc = { id: v.id, subnetId: v.subnets[0].id }; save();
    ok('vpc', v.id, 'subnet', v.subnets[0].id);
  },

  async db() {
    if (state.db) return log('db exists', state.db.id);
    if (!state.vpc) await steps.vpc();
    const engines = (await api('GET', '/databases/engines?page_size=100')).data.filter(e => e.engine === 'postgresql');
    const engine = engines.sort((a, b) => parseFloat(b.version) - parseFloat(a.version))[0];
    const body = {
      label: `${PREFIX}-pg`, region: REGION, type: process.env.DB_TYPE || 'g6-nanode-1', engine: engine.id, cluster_size: 1,
      allow_list: ['10.0.0.0/24'],
      private_network: { vpc_id: state.vpc.id, subnet_id: state.vpc.subnetId, public_access: false },
    };
    let d;
    try { d = await api('POST', '/databases/postgresql/instances', body); }
    catch (e) {
      fail('VPC-attached DB create failed:', e.message.slice(0, 300));
      log('retrying without private_network (allow_list will be locked to the Linodes) — note in Known limits');
      delete body.private_network; body.allow_list = [];
      d = await api('POST', '/databases/postgresql/instances', body);
      state.dbPublic = true;
    }
    state.db = { id: d.id, engine: engine.id }; save();
    ok('db provisioning', d.id, engine.id, '(~10 min). Run: node infra/provision.mjs db-wait');
  },

  async 'db-wait'() {
    for (;;) {
      const d = await api('GET', `/databases/postgresql/instances/${state.db.id}`);
      log('db status', d.status);
      if (d.status === 'active') {
        const c = await api('GET', `/databases/postgresql/instances/${state.db.id}/credentials`);
        const ssl = await api('GET', `/databases/postgresql/instances/${state.db.id}/ssl`).catch(() => null);
        if (ssl?.ca_certificate) { fs.mkdirSync(KEYS, { recursive: true }); fs.writeFileSync(path.join(KEYS, 'db-ca.crt'), Buffer.from(ssl.ca_certificate, 'base64')); }
        const host = d.private_network?.vpc_id ? (d.hosts.primary.startsWith('private-') ? d.hosts.primary : 'private-' + d.hosts.primary) : d.hosts.primary;
        state.db.host = host; state.db.publicHost = d.hosts.primary; state.db.port = d.port; save();
        const url = `postgres://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${host}:${d.port}/defaultdb`;
        setEnv({ DATABASE_URL: url, DATABASE_CA_FILE: '/etc/labstrata/db-ca.crt', USE_JSON_DB: '0' });
        ok('db ready at', host, '(private VPC hostname). DATABASE_URL written to .env');
        return;
      }
      await sleep(30000);
    }
  },

  async firewall() {
    if (state.firewall) return log('firewall exists', state.firewall);
    const myIps = (process.env.MY_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!myIps.length) {
      const ip = (await (await fetch('https://api.ipify.org')).text()).trim();
      myIps.push(ip + '/32'); log('MY_IPS not set; using this machine', ip);
    }
    const fw = await api('POST', '/networking/firewalls', {
      label: `${PREFIX}-fw`,
      rules: {
        inbound_policy: 'DROP', outbound_policy: 'ACCEPT',
        inbound: [
          { label: 'nodebalancer-http', action: 'ACCEPT', protocol: 'TCP', ports: '80', addresses: { ipv4: [NB_RANGE] } },
          { label: 'vpc-internal', action: 'ACCEPT', protocol: 'TCP', ports: '80', addresses: { ipv4: ['10.0.0.0/24'] } },
          { label: 'ssh-team', action: 'ACCEPT', protocol: 'TCP', ports: '22', addresses: { ipv4: myIps.map(x => (x.includes('/') ? x : x + '/32')) } },
        ],
      },
    });
    state.firewall = fw.id; save();
    ok('firewall', fw.id, '80 from', NB_RANGE, '+ 22 from', myIps.join(','));
  },

  async linodes() {
    if (!state.vpc) await steps.vpc();
    if (!state.firewall) await steps.firewall();
    const { pub } = sshKey();
    state.nodes ||= {};
    for (const [name, vpcIp] of [['a', '10.0.0.11'], ['b', '10.0.0.12']]) {
      if (state.nodes[name]) { log('linode', name, 'exists'); continue; }
      const l = await api('POST', '/linode/instances', {
        label: `${PREFIX}-${name}`, region: REGION, type: 'g6-standard-1', image: 'linode/ubuntu24.04',
        root_pass: crypto.randomBytes(24).toString('base64url') + 'A1!', authorized_keys: [pub], private_ip: true, firewall_id: state.firewall,
        interfaces: [{ purpose: 'public' }, { purpose: 'vpc', subnet_id: state.vpc.subnetId, ipv4: { vpc: vpcIp } }],
        tags: ['labstrata'],
      });
      state.nodes[name] = { id: l.id, publicIp: l.ipv4.find(ip => !ip.startsWith('192.168.')), privateIp: l.ipv4.find(ip => ip.startsWith('192.168.')), vpcIp };
      save();
      ok('linode', name, l.id, state.nodes[name].publicIp);
    }
    for (const n of Object.values(state.nodes)) {
      if (!n.privateIp) {
        const ips = await api('GET', `/linode/instances/${n.id}/ips`);
        n.privateIp = ips.ipv4.private?.[0]?.address;
        if (!n.privateIp) n.privateIp = (await api('POST', `/linode/instances/${n.id}/ips`, { type: 'ipv4', public: false })).address;
      }
    }
    save();
    log('wait ~1-2 min for boot, then: node infra/provision.mjs deploy');
  },

  async deploy(which) {
    const names = which ? [which] : Object.keys(state.nodes || {});
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
      .filter(l => /^(AKAMAI_|DATABASE_URL|DATABASE_SSL|S3_|CAL_|ADMIN_TOKEN|PUBLIC_URL|USE_JSON_DB)/.test(l)).join('\n');
    const ca = path.join(KEYS, 'db-ca.crt');
    for (const name of names) {
      const n = state.nodes[name];
      log('deploying node', name, n.publicIp);
      for (let i = 0; i < 20; i++) { try { ssh(n.publicIp, 'true'); break; } catch { log('waiting for ssh...'); await sleep(10000); } }
      const nodeEnv = `${env}\nPORT=80\nNODE_NAME=node-${name}\nCHECKER_FAULT=${n.fault ? 1 : 0}\nDATABASE_CA_FILE=/etc/labstrata/db-ca.crt\n`;
      ssh(n.publicIp, 'mkdir -p /etc/labstrata && cat > /etc/labstrata/env && chmod 600 /etc/labstrata/env', nodeEnv);
      if (fs.existsSync(ca)) ssh(n.publicIp, 'cat > /etc/labstrata/db-ca.crt', fs.readFileSync(ca, 'utf8'));
      const script = `set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y nodejs git >/dev/null
fi
id labstrata >/dev/null 2>&1 || useradd --system --home /opt/labstrata --shell /usr/sbin/nologin labstrata
if [ -f /opt/labstrata/app/package.json ] && [ ! -d /opt/labstrata/app/.git ]; then echo 'code shipped by tarball';
elif [ -d /opt/labstrata/app/.git ]; then cd /opt/labstrata/app && git fetch -q origin ${BRANCH} && git reset -q --hard origin/${BRANCH};
else mkdir -p /opt/labstrata && git clone -q -b ${BRANCH} ${REPO} /opt/labstrata/app; fi
cd /opt/labstrata/app && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null
chown -R labstrata:labstrata /opt/labstrata; chgrp labstrata /etc/labstrata/env /etc/labstrata/db-ca.crt 2>/dev/null || true; chmod 640 /etc/labstrata/env
cat > /etc/systemd/system/labstrata.service <<'UNIT'
[Unit]
Description=LabStrata
After=network-online.target
Wants=network-online.target
[Service]
User=labstrata
WorkingDirectory=/opt/labstrata/app
EnvironmentFile=/etc/labstrata/env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now labstrata >/dev/null 2>&1 && systemctl restart labstrata
sleep 3; curl -s localhost/calibration; echo`;
      if (process.env.SHIP_TARBALL) { // private repo: ship the committed code over ssh instead of git clone
        const tar = execFileSync('git', ['archive', '--format=tar.gz', 'HEAD'], { cwd: ROOT, maxBuffer: 100e6 }).toString('base64');
        ssh(n.publicIp, 'mkdir -p /opt/labstrata/app && base64 -d | tar xz -C /opt/labstrata/app', tar);
      }
      console.log(ssh(n.publicIp, 'bash -s', script));
      ok('node', name, 'deployed');
    }
  },

  async nodebalancer() {
    if (!state.nodes?.a) throw new Error('create linodes first');
    if (!state.nb) {
      const nb = await api('POST', '/nodebalancers', { label: `${PREFIX}-nb`, region: REGION, client_conn_throttle: 0 });
      state.nb = { id: nb.id, hostname: nb.hostname, ipv4: nb.ipv4 }; save();
      ok('nodebalancer', nb.id, nb.hostname, nb.ipv4);
    }
    if (!state.nb.httpConfig) {
      const c = await api('POST', `/nodebalancers/${state.nb.id}/configs`, nbConfig(80, 'http'));
      state.nb.httpConfig = c.id; save();
      for (const [name, n] of Object.entries(state.nodes)) {
        await api('POST', `/nodebalancers/${state.nb.id}/configs/${c.id}/nodes`, { label: `node-${name}`, address: `${n.privateIp}:80`, weight: 100, mode: 'accept' });
      }
      ok('port 80 config with health check /calibration ^(CALIBRATED|STALE)');
    }
    setEnv({ PUBLIC_URL: `http://${state.nb.hostname}` });
    log('public URL:', `http://${state.nb.hostname}`, ' (run "https" next for TLS)');
  },

  // TLS for the NodeBalancer hostname: temporarily route only to node A, run certbot (webroot served by the app at
  // /.well-known/acme-challenge from public/), then upload the cert to a port-443 NodeBalancer config.
  async https() {
    const a = state.nodes.a;
    const host = state.nb.hostname;
    const cfg = state.nb.httpConfig;
    const nodes = (await api('GET', `/nodebalancers/${state.nb.id}/configs/${cfg}/nodes`)).data;
    const nodeB = nodes.find(n => n.label === 'node-b');
    if (nodeB) await api('PUT', `/nodebalancers/${state.nb.id}/configs/${cfg}/nodes/${nodeB.id}`, { mode: 'reject' });
    try {
      const out = ssh(a.publicIp, 'bash -s', `set -e
command -v certbot >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot >/dev/null)
mkdir -p /opt/labstrata/app/public/.well-known/acme-challenge && chown -R labstrata /opt/labstrata/app/public/.well-known
certbot certonly --webroot -w /opt/labstrata/app/public -d ${host} --agree-tos --register-unsafely-without-email -n --keep-until-expiring >/dev/null
echo '---CERT---'; cat /etc/letsencrypt/live/${host}/fullchain.pem; echo '---KEY---'; cat /etc/letsencrypt/live/${host}/privkey.pem`);
      const ssl_cert = out.split('---CERT---')[1].split('---KEY---')[0].trim();
      const ssl_key = out.split('---KEY---')[1].trim();
      if (!state.nb.httpsConfig) {
        const c = await api('POST', `/nodebalancers/${state.nb.id}/configs`, { ...nbConfig(443, 'https'), ssl_cert, ssl_key });
        state.nb.httpsConfig = c.id; save();
        for (const [name, n] of Object.entries(state.nodes)) {
          await api('POST', `/nodebalancers/${state.nb.id}/configs/${c.id}/nodes`, { label: `node-${name}`, address: `${n.privateIp}:80`, weight: 100, mode: 'accept' });
        }
      } else {
        await api('PUT', `/nodebalancers/${state.nb.id}/configs/${state.nb.httpsConfig}`, { ssl_cert, ssl_key });
      }
      setEnv({ PUBLIC_URL: `https://${host}` });
      ok('HTTPS live at', `https://${host}`, '(redeploy so nodes pick up PUBLIC_URL)');
    } finally {
      if (nodeB) await api('PUT', `/nodebalancers/${state.nb.id}/configs/${cfg}/nodes/${nodeB.id}`, { mode: 'accept' });
    }
  },

  async fault(onoff) {
    const n = state.nodes.b;
    n.fault = onoff === 'on'; save();
    console.log(ssh(n.publicIp, `sed -i 's/^CHECKER_FAULT=.*/CHECKER_FAULT=${n.fault ? 1 : 0}/' /etc/labstrata/env && systemctl restart labstrata && sleep 2 && curl -s localhost/calibration`));
    ok('node b CHECKER_FAULT', n.fault ? 1 : 0);
  },

  async status() {
    console.log(JSON.stringify({ ...state }, null, 2));
    if (state.nb) {
      for (const cid of [state.nb.httpConfig, state.nb.httpsConfig].filter(Boolean)) {
        const nodes = (await api('GET', `/nodebalancers/${state.nb.id}/configs/${cid}/nodes`)).data;
        console.log(`config ${cid}:`, nodes.map(n => `${n.label}=${n.status}`).join('  '));
      }
    }
  },
};

function nbConfig(port, protocol) {
  return {
    port, protocol, algorithm: 'roundrobin', stickiness: 'none',
    check: 'http_body', check_path: '/calibration', check_body: '^(CALIBRATED|STALE)',
    check_interval: 5, check_timeout: 3, check_attempts: 2, check_passive: true,
  };
}

const [cmd, ...args] = process.argv.slice(2);
if (!steps[cmd]) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).join('\n')); process.exit(1); }
steps[cmd](...args).catch(e => { fail(e.message); process.exit(1); });
