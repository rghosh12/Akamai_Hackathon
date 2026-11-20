// LabStrata — protocol builder, version-locked assignments, and LabStrata Verify.
// Zero dependencies: Node 18+ (built-in fetch, crypto, http).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verify } = require('./lib/verify');
const { readPhoto } = require('./lib/vision');

// ---------- config ----------
loadEnv(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 3000);
const AKAMAI = {
  baseUrl: (process.env.AKAMAI_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.AKAMAI_API_KEY || '',
  model: process.env.AKAMAI_MODEL || '',
};
const akamaiReady = () => Boolean(AKAMAI.baseUrl && AKAMAI.apiKey && AKAMAI.model);

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- storage ----------
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const DEMO_DIR = path.join(__dirname, 'demo');
function readDb() {
  if (!fs.existsSync(DB_FILE)) return seedDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDb(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function seedDb() {
  const steps = [
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
  const db = { protocols: [], assignments: [], runs: [] };
  const proto = { id: 'p_' + rid(), title: 'SOP-EQ-014 Refrigerated Microcentrifuge Operation', versions: [] };
  proto.versions.push(makeVersion(proto.title, steps, null, 'Lab Manager'));
  db.protocols.push(proto);
  writeDb(db);
  return db;
}

// ---------- version control ----------
function rid() { return crypto.randomBytes(4).toString('hex'); }
// Canonical form: only the content that defines the procedure (no ids, no timestamps), keys sorted.
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
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ? canonical('', [a[i]]) : null;
    const y = b[i] ? canonical('', [b[i]]) : null;
    if (x === y) continue;
    out.push({ step: i + 1, approved: a[i] || null, submitted: b[i] || null });
  }
  return out;
}

// ---------- Akamai Inference Cloud (OpenAI-compatible chat completions) ----------
async function callAkamai(system, user) {
  const started = Date.now();
  const body = { model: AKAMAI.model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  let res = await post({ ...body, response_format: { type: 'json_object' } });
  // Structured output support varies by model; retry without it if rejected.
  if (res.status === 400) res = await post(body);
  const text = await res.text();
  if (!res.ok) throw new Error(`Akamai Inference HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content || '';
  return {
    json: extractJson(content),
    meta: {
      provider: 'Akamai Inference Cloud',
      endpoint: new URL(AKAMAI.baseUrl).host,
      model: data.model || AKAMAI.model,
      requestId: data.id || res.headers.get('x-request-id') || null,
      latencyMs: Date.now() - started,
      usage: data.usage || null,
    },
  };
  function post(b) {
    return fetch(AKAMAI.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AKAMAI.apiKey },
      body: JSON.stringify(b),
    });
  }
}
function extractJson(s) {
  const t = s.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('Model did not return JSON');
}

const DIFF_SYSTEM = `You review changes between an APPROVED lab protocol version and the copy an operator actually ran.
For each changed step, explain in one sentence what changed and rate the scientific/safety impact as "high", "medium" or "low".
Return ONLY JSON: {"changes":[{"step":int,"what_changed":str,"impact":"high"|"medium"|"low"}],"verdict":str}`;

async function explainDiff(diff) {
  if (!akamaiReady()) return { engine: 'local', error: 'Akamai Inference not configured (.env)' };
  try {
    const { json, meta } = await callAkamai(DIFF_SYSTEM, JSON.stringify(diff, null, 2));
    return { engine: 'akamai', meta, ...json };
  } catch (e) {
    return { engine: 'local', error: String(e.message || e) };
  }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req, limit = 2e6) => new Promise((ok, bad) => {
  let b = '', tooLarge = false;
  req.on('data', c => {
    if (tooLarge) return;
    b += c;
    if (b.length > limit) { tooLarge = true; bad(httpErr(413, 'request body too large')); }
  });
  req.on('end', () => { if (!tooLarge) try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } });
});

const routes = {
  'GET /api/config': () => ({ akamai: akamaiReady(), model: AKAMAI.model || null, endpoint: AKAMAI.baseUrl ? new URL(AKAMAI.baseUrl).host : null, publicUrl: process.env.PUBLIC_URL || null }),

  'GET /api/protocols': () => readDb().protocols.map(p => ({ id: p.id, title: p.title, versions: p.versions })),

  // Create a protocol, or a new version of one (pass id). Content hash = version identity.
  'POST /api/protocols': ({ id, title, steps, author }) => {
    if (!title || !Array.isArray(steps) || !steps.length) throw httpErr(400, 'title and at least one step required');
    const db = readDb();
    let p = id && db.protocols.find(x => x.id === id);
    if (!p) { p = { id: 'p_' + rid(), title, versions: [] }; db.protocols.push(p); }
    const latest = p.versions[p.versions.length - 1];
    const v = makeVersion(title, steps, latest ? latest.hash : null, author || 'Scientist');
    if (latest && latest.hash === v.hash) return { protocol: p, unchanged: true };
    p.title = title; p.versions.push(v); writeDb(db);
    return { protocol: p, version: v };
  },

  'GET /api/assignments': () => readDb().assignments,

  // Assignment pins an exact version hash.
  'POST /api/assignments': ({ protocolId, hash, assignee }) => {
    const db = readDb();
    const p = db.protocols.find(x => x.id === protocolId);
    const v = p && p.versions.find(x => x.hash === hash);
    if (!v || !assignee) throw httpErr(400, 'protocolId, hash and assignee required');
    const a = { id: 'a_' + rid(), protocolId, title: p.title, hash, version: p.versions.indexOf(v) + 1, assignee, createdAt: new Date().toISOString() };
    db.assignments.push(a); writeDb(db); return a;
  },

  'GET /api/assignment': (_, q) => {
    const db = readDb();
    const a = db.assignments.find(x => x.id === q.get('id'));
    if (!a) throw httpErr(404, 'assignment not found');
    const v = db.protocols.find(p => p.id === a.protocolId).versions.find(x => x.hash === a.hash);
    return { assignment: a, version: v };
  },

  // Operator submits the protocol content they actually ran + their answers.
  'POST /api/runs': async ({ assignmentId, title, steps, answers, operator }) => {
    const db = readDb();
    const a = db.assignments.find(x => x.id === assignmentId);
    if (!a) throw httpErr(404, 'assignment not found');
    const approved = db.protocols.find(p => p.id === a.protocolId).versions.find(x => x.hash === a.hash);
    const submittedHash = hashOf(title, steps);
    const match = submittedHash === a.hash;
    const missingRequired = steps.map((s, i) => (s.required && s.type !== 'text' && !answers?.[i] ? i + 1 : null)).filter(Boolean);
    let integrity = { match, approvedHash: a.hash, submittedHash };
    if (!match) {
      const diff = diffSteps(approved.steps, steps);
      if (approved.title !== title) diff.unshift({ step: 0, approved: { title: approved.title }, submitted: { title } });
      integrity.diff = diff;
      integrity.analysis = await explainDiff({ approved_hash: a.hash, submitted_hash: submittedHash, changed_steps: diff });
    }
    const run = { id: 'r_' + rid(), assignmentId, operator: operator || a.assignee, answers, missingRequired, integrity, createdAt: new Date().toISOString() };
    db.runs.push(run); writeDb(db); return run;
  },

  'GET /api/runs': () => readDb().runs,

  'GET /api/demo': () => ({
    sop: fs.readFileSync(path.join(DEMO_DIR, 'sop-centrifuge.txt'), 'utf8'),
    logs: {
      'Log A — compliant run': fs.readFileSync(path.join(DEMO_DIR, 'log-A-compliant.txt'), 'utf8'),
      'Log B — missed step': fs.readFileSync(path.join(DEMO_DIR, 'log-B-missed-step.txt'), 'utf8'),
    },
  }),

  'POST /api/verify': async ({ sop, log }) => {
    if (!sop || !log) throw httpErr(400, 'sop and log required');
    return verify(sop, log, { ready: akamaiReady, call: callAkamai });
  },

  'POST /api/read-photo': async ({ image }) => {
    if (!image) throw httpErr(400, 'image required');
    return readPhoto(image);
  },
};
function httpErr(code, msg) { const e = new Error(msg); e.code = code; return e; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && /^\/capture\/[^/]+$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return fs.createReadStream(path.join(__dirname, 'public', 'capture.html')).pipe(res);
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try { send(res, 200, await handler(req.method === 'POST' ? await readBody(req, url.pathname === '/api/read-photo' ? 8e6 : 2e6) : {}, url.searchParams)); }
    catch (e) { send(res, e.code || 500, { error: e.message }); }
    return;
  }
  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
if (require.main === module) server.listen(PORT, () => {
  console.log(`LabStrata on http://localhost:${PORT}`);
  console.log(akamaiReady() ? `Akamai Inference: ${AKAMAI.model} @ ${new URL(AKAMAI.baseUrl).host}` : 'Akamai Inference NOT configured — copy .env.example to .env');
});

module.exports = { hashOf };
