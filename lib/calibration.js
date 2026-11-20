// "We calibrate the AI checker like the lab calibrates the centrifuge."
// States: PENDING (not yet run) / CALIBRATED / STALE (inference unavailable: keep serving, badge says pending)
//         / OUT_OF_CALIBRATION (failed the exam: reviews paused, NodeBalancer pulls this node).
// Runs on boot and whenever the prompt/model hash changes (plus a manual button), never on a timer.
// Never uses the offline keyword fallback. GET /calibration never calls the model.
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const V = require('./verify');
const { AKAMAI } = require('./akamai');

const DIR = process.env.CALIBRATION_DIR || path.join(__dirname, '..', 'fixtures', 'calibration');
const THRESHOLD = Number(process.env.CAL_THRESHOLD || 0.85);
const NODE = process.env.NODE_NAME || os.hostname();

let state = { state: 'PENDING', correct: 0, total: 0, at: null, promptHash: null };
let running = null;

function loadCases() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
    .filter(c => c.sop && c.log && c.gold);
}
const okFor = (gold, pred) => (Array.isArray(gold) ? gold : [gold]).includes(pred);
const firstGold = g => (Array.isArray(g) ? g[0] : g);

// Score per step, not per log.
function score(cases, predsByCase) {
  let correct = 0, total = 0;
  const per = {}, confusion = {}, failures = [];
  cases.forEach((c, k) => {
    const preds = predsByCase[k];
    for (const [line, gold] of Object.entries(c.gold)) {
      const pred = preds.find(f => f.sop_line === Number(line))?.status || 'needs_review';
      const ok = okFor(gold, pred);
      const g = firstGold(gold);
      total++; if (ok) correct++;
      per[g] ||= { correct: 0, total: 0 }; per[g].total++; if (ok) per[g].correct++;
      confusion[g] ||= {}; confusion[g][pred] = (confusion[g][pred] || 0) + 1;
      if (!ok) failures.push({ case: c.id, sop_line: Number(line), gold, pred });
    }
  });
  return { correct, total, per_status: per, confusion, failures };
}

// Hard gates on top of accuracy: the hero step must never pass as verified, and injection must not flip a log to all-verified.
function hardGates(cases, predsByCase) {
  const problems = [];
  cases.forEach((c, k) => {
    for (const line of c.must_not_verify || []) {
      if (predsByCase[k].find(f => f.sop_line === line)?.status === 'verified') problems.push(`${c.id}: line ${line} passed as verified`);
    }
  });
  return problems;
}

async function run({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    const promptHash = V.promptHash();
    if (!require('./akamai').akamaiReady()) {
      state = { ...state, state: 'STALE', reason: 'Akamai Inference not configured', promptHash, at: new Date().toISOString() };
      return state;
    }
    if (!force) {
      const cached = await db.latestCalibration(promptHash).catch(() => null);
      if (cached) { state = fromRow(cached, true); return state; }
    }
    const cases = loadCases();
    if (!cases.length) { state = { ...state, state: 'STALE', reason: 'no calibration cases found', promptHash }; return state; }
    state = { ...state, running: true };
    let preds;
    try {
      preds = [];
      for (const c of cases) preds.push((await V.verify(c.sop, c.log, { allowFallback: false })).findings);
    } catch (e) {
      // 429 / timeout / any inference failure -> STALE, never OUT, never the offline fallback.
      state = { ...state, running: false, state: 'STALE', reason: String(e.message || e).slice(0, 200), at: new Date().toISOString(), promptHash };
      return state;
    }
    const s = score(cases, preds);
    const gates = hardGates(cases, preds);
    const baselinePreds = cases.map(c => V.localVerify(c.sop, c.log).findings);
    const b = score(cases, baselinePreds);
    const pass = s.total > 0 && s.correct / s.total >= THRESHOLD && gates.length === 0;
    const row = {
      node: NODE, prompt_hash: promptHash, prompt_version: V.promptVersion(), model: AKAMAI.model,
      state: pass ? 'CALIBRATED' : 'OUT_OF_CALIBRATION', correct: s.correct, total: s.total,
      per_status: s.per_status, confusion: { matrix: s.confusion, failures: s.failures, gates },
      baseline: { correct: b.correct, total: b.total, per_status: b.per_status, name: 'offline keyword matcher' },
    };
    await db.saveCalibration(row).catch(e => console.warn('calibration save failed:', e.message));
    state = fromRow({ ...row, created_at: new Date().toISOString() }, false);
    return state;
  })().finally(() => { running = null; });
  return running;
}

function fromRow(r, cached) {
  return {
    state: r.state, correct: r.correct, total: r.total, at: r.created_at, promptHash: r.prompt_hash, promptVersion: r.prompt_version,
    model: r.model, perStatus: r.per_status, confusion: r.confusion, baseline: r.baseline, node: NODE, cached, running: false,
  };
}

// Recalibrate if the prompt/model hash changed since the last result (e.g. CHECKER_FAULT toggled).
function ensureFresh() { if (state.promptHash !== V.promptHash() && !running) run().catch(() => {}); }

const hhmm = iso => (iso ? new Date(iso).toISOString().slice(11, 16) + ' UTC' : '');
// Plain text for the NodeBalancer health check: regex ^(CALIBRATED|STALE)
function healthText() {
  ensureFresh();
  const s = state;
  if (s.state === 'CALIBRATED' || s.state === 'OUT_OF_CALIBRATION') return `${s.state} ${s.correct}/${s.total} at ${hhmm(s.at)} prompt ${s.promptVersion} node ${NODE}`;
  if (s.state === 'STALE') return `STALE calibration pending (${s.reason || 'inference unavailable'}) node ${NODE}`;
  return `PENDING calibration running node ${NODE}`;
}
const current = () => ({ ...state, node: NODE, threshold: THRESHOLD });
const reviewsPaused = () => state.state === 'OUT_OF_CALIBRATION';

module.exports = { run, current, healthText, reviewsPaused, loadCases, score, ensureFresh };
