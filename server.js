// LabStrata — protocol builder, version-locked assignments, LabStrata Verify, and the Akamai Cloud layer.
// server.js is the router; logic lives in lib/ (akamai, verify, db, storage, calibration, vision).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnv(path.join(__dirname, '.env'));
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { AKAMAI, akamaiReady, endpointHost, embed } = require('./lib/akamai');
const V = require('./lib/verify');
const db = require('./lib/db');
const storage = require('./lib/storage');
const calibration = require('./lib/calibration');
const visionBasic = require('./lib/vision-basic');   // reads a photo already in the capture bucket (by key)
const { readPhoto } = require('./lib/vision');        // reads a photo sent directly as base64 (fallback upload)

const PORT = Number(process.env.PORT || 3000);
const DEMO_DIR = path.join(__dirname, 'demo');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// ---------- seed ----------
const SEED_STEPS = [
  { type: 'text', label: 'Wear lab coat, nitrile gloves and safety glasses.', required: false },
  { type: 'input', label: 'Calibration due date (from sticker)', inputType: 'text', required: true },
  { type: 'input', label: 'Rotor serial number', inputType: 'text', required: true },
  { type: 'input', label: 'Displayed chamber temperature before loading (°C)', inputType: 'number', required: true },
  { type: 'question', label: 'Are tubes balanced in opposite positions within 0.1 g?', options: ['Yes', 'No'], required: true },
  { type: 'input', label: 'Tube masses (g), comma-separated', inputType: 'text', required: true },
  { type: 'text', label: 'Tighten rotor lid until it clicks, then close the chamber lid.', required: false },
  { type: 'timer', label: 'Run: 12,000 x g at 4 °C', seconds: 600, required: true },
  { type: 'question', label: 'Any leaks observed on removal?', options: ['No', 'Yes — follow SOP-BIO-003'], required: true },
  { type: 'input', label: 'Run end time', inputType: 'text', required: true },
];
const SEED_TITLE = 'SOP-EQ-014 Refrigerated Microcentrifuge Operation';
async function ensureSeed() {
  if ((await db.listProtocols()).length) return;
  await db.saveVersion('p_sopeq014', SEED_TITLE, makeVersion(SEED_TITLE, SEED_STEPS, null, 'Lab Manager'));
}

// ---------- version control ----------
function rid() { return crypto.randomBytes(4).toString('hex'); }
function canonical(title, steps) {
  const clean = steps.map(s => {
    const o = { type: s.type, label: String(s.label || '').trim(), required: Boolean(s.required) };
    if (s.type === 'timer') o.seconds = Number(s.seconds) || 0;
    if (s.type === 'question') o.options = (s.options || []).map(x => String(x).trim());
    if (s.type === 'input') o.inputType = s.inputType || 'text';
    return o;
  });
  return stableStringify({ title: String(title).trim(), steps: clean });
}
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function hashOf(title, steps) { return crypto.createHash('sha256').update(canonical(title, steps)).digest('hex'); }
function makeVersion(title, steps, parentHash, author) {
  return { hash: hashOf(title, steps), parentHash, title, steps, author, createdAt: new Date().toISOString() };
}
function diffSteps(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ? canonical('', [a[i]]) : null, y = b[i] ? canonical('', [b[i]]) : null;
    if (x !== y) out.push({ step: i + 1, approved: a[i] || null, submitted: b[i] || null });
  }
  return out;
}

// ---------- "this log doesn't match the assigned SOP" (an input it cannot answer) ----------
// Code check before any tokens are spent: a different SOP id in the log, or almost no step overlap.
function sopMatch(sop, log) {
  const sopId = (sop.match(/\b([A-Z]{2,4}-[A-Z]{2,4}-\d{2,4})\b/) || [])[1];
  const logIds = [...log.matchAll(/\b([A-Z]{2,4}-[A-Z]{2,4}-\d{2,4})\b/g)].map(m => m[1]).filter(x => !/^SOP-BIO/.test(x));
  if (sopId && logIds.length && !logIds.includes(sopId)) return { match: false, reason: `Log refers to ${logIds[0]}, not ${sopId}.` };
  const f = V.localVerify(sop, log).findings;
  const hit = f.filter(x => x.status !== 'missed').length / Math.max(1, f.length);
  if (hit < 0.3) return { match: false, reason: `Only ${Math.round(hit * 100)}% of SOP steps have any related log line.` };
  return { match: true };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, bad) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } });
});
function httpErr(code, msg, extra) { const e = new Error(msg); e.code = code; e.extra = extra; return e; }
const requireAdmin = req => { if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) throw httpErr(401, 'admin token required'); };
const baseUrl = req => PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

const routes = {
  'GET /api/config': () => ({
    akamai: akamaiReady(), model: AKAMAI.model || null, visionModel: AKAMAI.visionModel, embedModel: AKAMAI.embedModel, endpoint: endpointHost(), publicUrl: PUBLIC_URL || null,
    db: db.mode(), storage: { ready: storage.storageReady(), lockMode: storage.CFG.lockMode, region: storage.CFG.region },
    calibration: calibration.current(), node: process.env.NODE_NAME || require('os').hostname(),
  }),

  'GET /api/protocols': () => db.listProtocols(),

  'POST /api/protocols': async ({ id, title, steps, author }) => {
    if (!title || !Array.isArray(steps) || !steps.length) throw httpErr(400, 'title and at least one step required');
    const existing = id && (await db.getProtocol(id));
    const latest = existing?.versions.at(-1);
    const v = makeVersion(title, steps, latest ? latest.hash : null, author || 'Scientist');
    if (latest && latest.hash === v.hash) return { protocol: existing, unchanged: true };
    const protocol = await db.saveVersion(existing ? id : 'p_' + rid(), title, v);
    return { protocol, version: v };
  },

  'GET /api/assignments': () => db.listAssignments(),

  'POST /api/assignments': async ({ protocolId, hash, assignee }, _, req) => {
    const p = await db.getProtocol(protocolId);
    const v = p && p.versions.find(x => x.hash === hash);
    if (!v || !assignee) throw httpErr(400, 'protocolId, hash and assignee required');
    const id = 'a_' + rid();
    const a = { id, protocolId, title: p.title, hash, version: p.versions.indexOf(v) + 1, assignee, createdAt: new Date().toISOString(), captureUrl: `${baseUrl(req)}/capture/${id}`, photos: [] };
    return db.addAssignment(a);
  },

  'GET /api/assignment': async (_, q) => {
    const a = await db.getAssignment(q.get('id'));
    if (!a) throw httpErr(404, 'assignment not found');
    const v = (await db.getProtocol(a.protocolId)).versions.find(x => x.hash === a.hash);
    return { assignment: a, version: v };
  },

  'POST /api/runs': async ({ assignmentId, title, steps, answers, operator }) => {
    const a = await db.getAssignment(assignmentId);
    if (!a) throw httpErr(404, 'assignment not found');
    const approved = (await db.getProtocol(a.protocolId)).versions.find(x => x.hash === a.hash);
    const submittedHash = hashOf(title, steps);
    const match = submittedHash === a.hash;
    const missingRequired = steps.map((s, i) => (s.required && s.type !== 'text' && !answers?.[i] ? i + 1 : null)).filter(Boolean);
    const integrity = { match, approvedHash: a.hash, submittedHash };
    if (!match) {
      const diff = diffSteps(approved.steps, steps);
      if (approved.title !== title) diff.unshift({ step: 0, approved: { title: approved.title }, submitted: { title } });
      integrity.diff = diff;
      integrity.analysis = await V.explainDiff({ approved_hash: a.hash, submitted_hash: submittedHash, changed_steps: diff });
    }
    return db.addRun({ id: 'r_' + rid(), kind: 'integrity', assignmentId, operator: operator || a.assignee, answers, missingRequired, integrity, createdAt: new Date().toISOString() });
  },

  'GET /api/runs': () => db.listRuns(),

  'GET /api/demo': () => ({
    sop: fs.readFileSync(path.join(DEMO_DIR, 'sop-centrifuge.txt'), 'utf8'),
    logs: Object.fromEntries(fs.readdirSync(DEMO_DIR).filter(f => /^log-.*\.txt$/.test(f)).map(f => [
      f.replace(/^log-|\.txt$/g, '').replace(/^(\w)-/, 'Log $1 — ').replace(/-/g, ' '), fs.readFileSync(path.join(DEMO_DIR, f), 'utf8')])),
  }),

  // ---- Verify (paused when this node is out of calibration) ----
  'POST /api/verify': async ({ sop, log, assignmentId, photoKey, operator, vision: visionResult }) => {
    if (!sop || !log) throw httpErr(400, 'sop and log required');
    if (calibration.reviewsPaused()) throw httpErr(503, 'Reviews paused: checker out of calibration', { paused: true, calibration: calibration.current() });
    const m = sopMatch(sop, log);
    if (!m.match) return { engine: 'code', doesNotMatch: true, message: `This log doesn't match the assigned SOP. ${m.reason}`, findings: [] };
    const result = await V.verify(sop, log);
    const a = assignmentId ? await db.getAssignment(assignmentId) : null;
    const op = operator || a?.assignee || 'unknown';
    const run = {
      id: 'v_' + rid(), kind: 'verify', assignmentId: assignmentId || null, operator: op, photoKey: photoKey || null,
      sopHash: a?.hash || null, sopTitle: a?.title || null, sop, log, vision: visionResult || null,
      engine: result.engine, meta: result.meta || null, prompt: result.prompt || null, findings: result.findings,
      numberChecks: result.numberChecks, calibration: calibration.current(), createdAt: new Date().toISOString(),
    };
    // Repeat-deviation memory: embed non-verified findings (qwen3-embedding-8b) and look up similar past ones.
    const flagged = result.findings.filter(f => f.status !== 'verified');
    let vecs = [];
    if (akamaiReady() && flagged.length) {
      try { vecs = await embed(flagged.map(f => `${f.sop_text} | ${f.status}`)); } catch (e) { console.warn('embed failed:', e.message); }
    }
    for (const [i, f] of flagged.entries()) {
      try { f.similar = await db.similarFindings(f, vecs[i], run.id); } catch (e) { f.similar = null; }
    }
    await db.addRun(run);
    try { await db.addFindings(run.id, op, flagged, vecs); } catch (e) { console.warn('findings save failed:', e.message); }
    return { ...result, runId: run.id, calibration: calibration.current() };
  },

  // ---- Calibration ----
  'GET /api/calibration': () => calibration.current(),
  'POST /api/calibration/run': async (_, __, req) => { requireAdmin(req); return calibration.run({ force: true }); },

  // ---- Phone capture: presigned PUT straight to Object Storage ----
  'POST /api/capture/presign': async ({ assignmentId, contentType }) => {
    if (!storage.storageReady()) throw httpErr(503, 'Object Storage not configured');
    const a = await db.getAssignment(assignmentId);
    if (!a) throw httpErr(404, 'assignment not found');
    const ct = /^image\/(jpeg|png|heic|heif|webp)$/.test(contentType || '') ? contentType : 'image/jpeg';
    const ext = { 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' }[ct] || 'jpg';
    return storage.presignPut(`captures/${assignmentId}/${Date.now()}.${ext}`, ct, 600);
  },
  'POST /api/capture/done': async ({ assignmentId, key }) => {
    const a = await db.getAssignment(assignmentId);
    if (!a || !String(key || '').startsWith(`captures/${assignmentId}/`)) throw httpErr(400, 'bad capture');
    if (!(await storage.objectExists(key))) throw httpErr(400, 'photo not found in bucket');
    return db.updateAssignment(assignmentId, { photos: [...(a.photos || []), { key, at: new Date().toISOString() }] });
  },
  'GET /api/capture/latest': async (_, q) => {
    const a = await db.getAssignment(q.get('assignmentId'));
    if (!a) throw httpErr(404, 'assignment not found');
    const p = (a.photos || []).at(-1);
    if (!p) return { photo: null };
    const view = await storage.presignGet(p.key, { bucket: storage.CFG.captureBucket, expiresIn: 3600 });
    return { photo: { ...p, url: view.url } };
  },
  // Gemma reads the handwriting. Unreadable lines are reported, never guessed.
  'POST /api/read-photo': async ({ key, image }) => {
    if (key) return visionBasic.readPage(key);
    if (image) return readPhoto(image);
    throw httpErr(400, 'key or image required');
  },

  // ---- Sign + seal (Object Lock), tamper attempt, auditor share ----
  'POST /api/sign': async ({ runId, reviewer }) => {
    const run = await db.getRun(runId);
    if (!run || run.kind !== 'verify') throw httpErr(404, 'verify run not found');
    if (!reviewer) throw httpErr(400, 'reviewer name required');
    const existing = await db.getSeal(runId);
    if (existing) return { alreadySealed: true, seal: publicSeal(existing) };
    const packet = {
      record: 'LabStrata run review', run_id: run.id, sop_title: run.sopTitle, sop_version_hash: run.sopHash, assignment_id: run.assignmentId,
      operator: run.operator, photo_key: run.photoKey, log: run.log, findings: run.findings.map(f => ({
        sop_line: f.sop_line, sop_text: f.sop_text, status: f.status, log_line: f.log_line, log_text: f.log_text, reason: f.reason, number_check: f.number_check || null })),
      model: { engine: run.engine, ...(run.meta || {}), prompt_version: run.prompt, calibration: run.calibration && { state: run.calibration.state, correct: run.calibration.correct, total: run.calibration.total, at: run.calibration.at } },
      reviewer, signed_at: new Date().toISOString(), human_review_required: true,
      note: 'Assistant output reviewed and signed by a qualified human. Not a compliance verdict.',
    };
    const s = await storage.sealPacket(runId, packet);
    const row = { run_id: runId, bucket: s.bucket, key: s.key, version_id: s.versionId, sha256: s.sha256, lock_mode: s.lockMode, packet };
    await db.saveSeal(row);
    await db.updateRun(runId, { signedBy: reviewer, sealed: true });
    return { seal: { ...publicSeal(row), retainUntil: s.retainUntil } };
  },
  'GET /api/seal': async (_, q) => {
    const s = await db.getSeal(q.get('runId'));
    if (!s) throw httpErr(404, 'not sealed');
    return publicSeal(s);
  },
  'POST /api/tamper': async ({ runId }) => {
    const seal = await db.getSeal(runId);
    if (!seal) throw httpErr(404, 'not sealed');
    const attempt = await storage.tamperAttempt(seal);
    await db.logTamper(runId, attempt);
    return attempt;
  },
  'POST /api/share': async ({ runId }) => {
    const seal = await db.getSeal(runId);
    if (!seal) throw httpErr(404, 'not sealed');
    return { ...(await storage.presignGet(seal.key, { versionId: seal.version_id, expiresIn: 86400 })), versionId: seal.version_id, sha256: seal.sha256 };
  },

  // QR code (SVG) for the capture link.
  'GET /api/qr': async (_, q) => ({ svg: await require('qrcode').toString(q.get('text') || '', { type: 'svg', margin: 1 }) }),

  'POST /api/admin/reset': async (_, __, req) => { requireAdmin(req); await db.resetDemo(); await ensureSeed(); return { ok: true }; },
};
const publicSeal = s => ({ runId: s.run_id, bucket: s.bucket, key: s.key, versionId: s.version_id, sha256: s.sha256, lockMode: s.lock_mode, sealedAt: s.created_at });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // NodeBalancer health check: plain text, regex ^(CALIBRATED|STALE). Never calls the model.
  if (url.pathname === '/calibration') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(calibration.healthText()); }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try { send(res, 200, await handler(req.method === 'POST' ? await readBody(req) : {}, url.searchParams, req)); }
    catch (e) { if (!e.code || e.code >= 500) console.error(e); send(res, typeof e.code === 'number' ? e.code : 500, { error: e.message, ...(e.extra || {}) }); }
    return;
  }
  const rel = /^\/capture\/[\w-]+$/.test(url.pathname) ? 'capture.html' : url.pathname === '/' ? 'index.html' : path.normalize(url.pathname);
  const file = path.join(__dirname, 'public', rel);
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

async function start() {
  const info = await db.init();
  await ensureSeed();
  server.listen(PORT, () => {
    console.log(`LabStrata on http://localhost:${PORT}  db=${info.mode}${info.vector ? '+pgvector' : ''}  storage=${storage.storageReady() ? 'on' : 'off'}`);
    console.log(akamaiReady() ? `Akamai Inference: ${AKAMAI.model} @ ${endpointHost()}` : 'Akamai Inference NOT configured — copy .env.example to .env');
  });
  calibration.run().then(s => console.log('calibration:', s.state, `${s.correct}/${s.total}`)).catch(e => console.error('calibration error', e));
}
if (require.main === module) start().catch(e => { console.error(e); process.exit(1); });

module.exports = { localVerify: V.localVerify, checkCitations: V.checkCitations, hashOf, sopMatch, server, start, ensureSeed };
