// Hands-free LabStrata demo: drives all 9 beats against the PUBLIC URL, asserts each really happened,
// records 1920x1080 (+ phone inset), adds plain-English captions, stitches with ffmpeg.
//   node demo-auto/run-demo.mjs            -> record demo-auto/out/labstrata-demo.mp4
//   LIVE=1 node demo-auto/run-demo.mjs     -> headed Chrome, no recording (demo-auto/live.sh)
// UI hooks: elements are found by [data-demo="..."] first, then by visible text (see demo-auto/README.md).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'out');
loadEnv(path.join(ROOT, '.env'));
const URL_ = (process.env.DEMO_URL || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
const LIVE = process.env.LIVE === '1';
const PAUSE = Number(process.env.BEAT_PAUSE_MS || (LIVE ? 2500 : 4500));
const PHOTO = process.env.DEMO_PHOTO || path.join(HERE, 'assets', 'notebook-page.jpg');
const UNREADABLE = process.env.DEMO_PHOTO_UNREADABLE || path.join(HERE, 'assets', 'notebook-unreadable.jpg');
const ADMIN = process.env.ADMIN_TOKEN || '';
const SCRIPT = fs.readFileSync(path.join(HERE, 'script.md'), 'utf8').split('\n').filter(l => /^\d+\./.test(l)).map(l => l.replace(/^\d+\.\s*/, ''));
const t0 = Date.now();
const marks = [];

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) { console.error('\x1b[31mBEAT FAILED:\x1b[0m', msg); throw new Error(msg); } console.log('  \x1b[32m✓\x1b[0m', msg); }

async function caption(page, text) {
  await page.evaluate(t => {
    let el = document.getElementById('__demo_caption');
    if (!el) {
      el = document.createElement('div'); el.id = '__demo_caption';
      Object.assign(el.style, { position: 'fixed', left: '50%', bottom: '36px', transform: 'translateX(-50%)', maxWidth: '1500px', zIndex: 2147483647,
        background: 'rgba(10,20,16,.88)', color: '#fff', font: '600 34px/1.3 system-ui, Segoe UI, sans-serif', padding: '18px 30px', borderRadius: '14px',
        textAlign: 'center', boxShadow: '0 8px 30px rgba(0,0,0,.35)', pointerEvents: 'none' });
      document.body.append(el);
    }
    el.textContent = t; el.style.display = t ? 'block' : 'none';
  }, text).catch(() => {});
}
async function beat(n, page, fn) {
  const text = SCRIPT[n - 1] || '';
  console.log(`\nBeat ${n}: ${text}`);
  marks.push({ n, at: (Date.now() - t0) / 1000, text });
  await caption(page, text);
  await fn();
  await caption(page, text);
  await sleep(PAUSE);
}
// [data-demo=x] first, else a text/role fallback
async function el(page, hook, fallback) {
  const h = page.locator(`[data-demo="${hook}"]`).first();
  if (await h.count()) return h;
  return typeof fallback === 'string' ? page.getByText(new RegExp(fallback, 'i')).first() : fallback(page);
}
async function click(page, hook, fallback) { const l = await el(page, hook, fallback); await l.scrollIntoViewIfNeeded().catch(() => {}); await l.click(); }
const api = async (page, p, body) => {
  const r = body ? await page.request.post(URL_ + '/api' + p, { data: body, headers: ADMIN ? { 'x-admin-token': ADMIN } : {} }) : await page.request.get(URL_ + '/api' + p);
  return { status: r.status(), json: await r.json().catch(() => ({})) };
};

// ---------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: !LIVE, channel: LIVE ? 'chrome' : undefined, args: ['--window-size=1920,1080'] });
const desk = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ...(LIVE ? {} : { recordVideo: { dir: path.join(OUT, 'desk'), size: { width: 1920, height: 1080 } } }) });
const page = await desk.newPage();
let phoneStart = 0, ctx = {};
let ok = false;
try {
  await page.goto(URL_, { waitUntil: 'networkidle' });

  // 1. Opening: story + FDA number + pitch
  await beat(1, page, async () => {
    const cfg = await api(page, '/config');
    assert(cfg.status === 200, 'app is up at ' + URL_);
    ctx.cfg = cfg.json;
  });

  // 2. Assign SOP-EQ-014 v1 -> QR -> phone photographs the notebook -> lands in the bucket
  await beat(2, page, async () => {
    await click(page, 'tab-assign', p => p.getByRole('button', { name: /assign/i }).first());
    const who = await el(page, 'assignee', p => p.locator('#aWho'));
    await who.fill('M. Chen');
    await click(page, 'assign-button', p => p.getByRole('button', { name: /^assign/i }).last());
    await sleep(1200);
    const list = (await api(page, '/assignments')).json;
    ctx.assignment = list.at(-1);
    assert(ctx.assignment && /SOP-EQ-014/.test(ctx.assignment.title), `assignment ${ctx.assignment?.id} pins SOP-EQ-014 v${ctx.assignment?.version}`);
    const qr = page.locator('[data-demo="capture-qr"]');
    if (await qr.count()) await qr.first().scrollIntoViewIfNeeded();

    // Real phone path: iPhone context opens /capture/:id and uploads through the presigned PUT.
    phoneStart = (Date.now() - t0) / 1000;
    const phoneCtx = await browser.newContext({ ...devices['iPhone 14'], ...(LIVE ? {} : { recordVideo: { dir: path.join(OUT, 'phone'), size: { width: 390, height: 844 } } }) });
    const phone = await phoneCtx.newPage();
    await phone.goto(`${URL_}/capture/${ctx.assignment.id}`, { waitUntil: 'networkidle' });
    await sleep(1000);
    await phone.locator('input[type=file]').first().setInputFiles(PHOTO);
    await sleep(800);
    const submit = phone.locator('[data-demo="capture-submit"]');
    if (await submit.count()) await submit.click();
    await phone.waitForFunction(() => /uploaded|sent|done|received/i.test(document.body.innerText), null, { timeout: 30000 });
    await sleep(1500);
    await phoneCtx.close();
    const latest = (await api(page, '/capture/latest?assignmentId=' + ctx.assignment.id)).json;
    assert(latest.photo?.key, 'photo landed in the Object Storage bucket: ' + latest.photo?.key);
    ctx.photoKey = latest.photo.key;
  });

  // 3. Gemma reads the page; shown beside the photo
  await beat(3, page, async () => {
    await click(page, 'tab-verify', p => p.getByRole('button', { name: /verify/i }).first());
    await click(page, 'load-photo', p => p.getByRole('button', { name: /photo|notebook/i }).first()).catch(() => {});
    await page.locator('[data-demo="read-lines"], .read-lines').first().waitFor({ timeout: 90000 }).catch(() => {});
    const read = await api(page, '/read-photo', { key: ctx.photoKey });
    assert(read.status === 200 && read.json.lines?.length > 3, `Gemma read ${read.json.lines?.length} lines (${read.json.meta?.model})`);
    ctx.read = read.json;
  });

  // 4. Verify: hero finding + unverifiable + code-checked numbers
  await beat(4, page, async () => {
    await click(page, 'verify-button', p => p.getByRole('button', { name: /verify with/i }).first());
    await page.waitForFunction(() => /not documented|missed/i.test(document.body.innerText), null, { timeout: 120000 });
    const runs = (await api(page, '/runs')).json.filter(r => r.kind === 'verify');
    ctx.run = runs.at(-1);
    const step4 = ctx.run?.findings?.find(f => /balance the rotor/i.test(f.sop_text || ''));
    assert(step4 && step4.status !== 'verified', `Step 4 (balance the rotor) is "${step4?.status}", not verified`);
    assert(ctx.run.findings.some(f => f.status === 'unverifiable'), 'unverifiable findings present (rotor serial / temperature)');
    const row = page.locator('[data-demo="finding"][data-status="missed"], [data-demo="finding"]').first();
    if (await row.count()) await row.click();
  });

  // 5. Reviewer signs -> sealed in Object Lock -> "Try to alter this record" -> AccessDenied + intact
  await beat(5, page, async () => {
    const name = await el(page, 'reviewer', p => p.getByLabel(/reviewer/i));
    await name.fill('Dr. A. Rivera (QA)');
    await click(page, 'sign-button', p => p.getByRole('button', { name: /sign/i }).first());
    await page.waitForFunction(() => /sealed/i.test(document.body.innerText), null, { timeout: 30000 });
    await click(page, 'tamper-button', p => p.getByRole('button', { name: /alter this record/i }).first());
    await page.waitForFunction(() => /AccessDenied/i.test(document.body.innerText), null, { timeout: 30000 });
    const seal = (await api(page, '/seal?runId=' + ctx.run.id)).json;
    assert(seal.versionId && seal.sha256, `sealed version ${seal.versionId?.slice(0, 12)}… sha256 ${seal.sha256?.slice(0, 12)}…`);
    assert(/Original intact/i.test(await page.locator('body').innerText()), 'UI shows "Original intact; tamper attempt detected and logged"');
  });

  // 6. Auditor share link (24 h)
  await beat(6, page, async () => {
    await click(page, 'share-button', p => p.getByRole('button', { name: /share|auditor/i }).first());
    const link = await (await el(page, 'share-link', p => p.locator('input[readonly], a[href*="X-Amz-"]'))).first();
    const href = (await link.getAttribute('href')) || (await link.inputValue().catch(() => ''));
    assert(/X-Amz-Expires=86400/.test(href), 'presigned auditor link expires in 24 h');
    const r = await page.request.get(href);
    assert(r.ok() && /human_review_required/.test(await r.text()), 'auditor link opens the sealed packet');
  });

  // 7. Calibration badge, then the bad prompt deploy on node B
  await beat(7, page, async () => {
    const cal = (await api(page, '/calibration')).json;
    assert(/CALIBRATED|STALE/.test(cal.state), `badge: ${cal.state} ${cal.correct}/${cal.total}`);
    const badge = page.locator('[data-demo="calibration-badge"]');
    if (await badge.count()) await badge.first().hover();
    if (process.env.SKIP_FAULT !== '1') {
      execFileSync('node', [path.join(ROOT, 'infra', 'provision.mjs'), 'fault', 'on'], { stdio: 'inherit' });
      const down = await waitNode('node-b', s => s === 'DOWN', 180);
      assert(down, 'NodeBalancer marked node B DOWN (failed its exam)');
      // Show node B's own UI through an SSH tunnel (the firewall blocks it from the internet).
      const tunnel = openTunnel();
      try {
        const b = await desk.newPage();
        await b.goto('http://localhost:18081', { waitUntil: 'networkidle' });
        await caption(b, SCRIPT[6]);
        await b.waitForFunction(() => /reviews paused/i.test(document.body.innerText), null, { timeout: 60000 });
        assert(true, 'node B UI says "Reviews paused: checker out of calibration"');
        await sleep(PAUSE);
        await b.close();
      } finally { tunnel.kill(); }
    }
  });

  // 8. Inputs it cannot answer: unreadable photo -> "retake"; wrong SOP -> "doesn't match"
  await beat(8, page, async () => {
    const wrong = 'Run log SOP-BIO-003 autoclave | Operator: M. Chen\n10:00 Loaded autoclave bags.\n10:05 Cycle 121 °C 30 min started.';
    const sop = (await api(page, '/demo')).json.sop;
    const r = await api(page, '/verify', { sop, log: wrong });
    assert(r.json.doesNotMatch, 'wrong-SOP log: ' + r.json.message);
    const vlog = page.locator('#vLog');
    if (await vlog.count()) { await vlog.fill(wrong); await click(page, 'verify-button', p => p.getByRole('button', { name: /verify with/i }).first()); }
    await page.waitForFunction(() => /doesn.t match/i.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
    if (fs.existsSync(UNREADABLE)) {
      const pre = (await api(page, '/capture/presign', { assignmentId: ctx.assignment.id, contentType: 'image/jpeg' })).json;
      const put = await page.request.put(pre.url, { data: fs.readFileSync(UNREADABLE), headers: { 'Content-Type': 'image/jpeg' } });
      assert(put.ok(), 'unreadable photo uploaded via presigned PUT');
      const read = (await api(page, '/read-photo', { key: pre.key })).json;
      assert(read.status === 'unreadable' || read.lines?.some(l => l.unreadable), `unreadable page -> "${read.message || read.status}"`);
    }
  });

  // 9. Close
  await beat(9, page, async () => {
    if (process.env.SKIP_FAULT !== '1') execFileSync('node', [path.join(ROOT, 'infra', 'provision.mjs'), 'fault', 'off'], { stdio: 'inherit' });
    await page.goto(URL_, { waitUntil: 'networkidle' });
  });
  ok = true;
} catch (e) {
  console.error(e.message);
} finally {
  await caption(page, '');
  const deskVideo = await page.video()?.path().catch(() => null);
  await desk.close();
  await browser.close();
  if (!ok) { console.error('\nDEMO FAILED: not stitching a broken take.'); process.exit(1); }
  if (!LIVE) await stitch(deskVideo);
}

// ---------------------------------------------------------------
async function waitNode(label, pred, timeoutS) {
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra', 'state.json'), 'utf8'));
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    const r = await fetch(`https://api.linode.com/v4/nodebalancers/${state.nb.id}/configs/${state.nb.httpsConfig || state.nb.httpConfig}/nodes`, { headers: { Authorization: 'Bearer ' + process.env.LINODE_TOKEN } });
    const n = (await r.json()).data?.find(x => x.label === label);
    console.log('   ', label, n?.status);
    if (n && pred(n.status)) return true;
    await sleep(5000);
  }
  return false;
}
function openTunnel() {
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra', 'state.json'), 'utf8'));
  const key = path.join(ROOT, 'infra', 'keys', 'id_ed25519');
  const p = spawn('ssh', ['-i', key, '-N', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(ROOT, 'infra', 'keys', 'known_hosts'), '-L', '18081:localhost:80', `root@${state.nodes.b.publicIp}`], { stdio: 'ignore' });
  execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},2500)']);
  return p;
}
async function stitch(deskVideo) {
  const phoneDir = path.join(OUT, 'phone');
  const phoneVideo = fs.existsSync(phoneDir) ? fs.readdirSync(phoneDir).map(f => path.join(phoneDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] : null;
  fs.writeFileSync(path.join(OUT, 'beats.json'), JSON.stringify({ marks, phoneStart }, null, 2));
  const final = path.join(OUT, 'labstrata-demo.mp4');
  let hasFfmpeg = true;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }
  if (!hasFfmpeg) { console.log('ffmpeg not found: raw recording at', deskVideo); return; }
  const narration = path.join(OUT, 'narration.mp3');
  const args = ['-y', '-i', deskVideo];
  let filter = '[0:v]format=yuv420p[base]';
  if (phoneVideo) {
    args.push('-itsoffset', String(phoneStart), '-i', phoneVideo);
    filter = `[1:v]scale=360:-2,pad=iw+16:ih+16:8:8:color=black[ph];[0:v][ph]overlay=W-w-40:40:enable='gte(t,${phoneStart})':eof_action=pass,format=yuv420p[base]`;
  }
  if (fs.existsSync(narration)) args.push('-i', narration);
  args.push('-filter_complex', filter, '-map', '[base]');
  if (fs.existsSync(narration)) args.push('-map', `${phoneVideo ? 2 : 1}:a`, '-c:a', 'aac');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-t', '299', final);
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', final], { encoding: 'utf8' }).trim();
  console.log(`\n\x1b[32mDONE\x1b[0m ${final}  length ${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}`);
}
