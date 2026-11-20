// Storage: Managed PostgreSQL (+ pgvector) over the VPC. db.json fallback behind USE_JSON_DB=1 (or no DATABASE_URL).
// Postgres is required in production because two app nodes would each have a different db.json.
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
let pool = null;
let hasVector = false;
const usePg = () => Boolean(process.env.DATABASE_URL) && process.env.USE_JSON_DB !== '1';

// ---------------- JSON fallback ----------------
const EMPTY = () => ({ protocols: [], assignments: [], runs: [], findings: [], calibration: [], seals: [], tamper: [] });
function readJson() {
  if (!fs.existsSync(DB_FILE)) return null;
  return { ...EMPTY(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
}
function writeJson(db) { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let jsonDb = null;
const J = () => (jsonDb ||= readJson() || EMPTY());
const saveJ = () => writeJson(J());

// ---------------- Postgres ----------------
const SCHEMA = vec => `
CREATE TABLE IF NOT EXISTS protocols (id text PRIMARY KEY, title text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS versions (
  hash text PRIMARY KEY, protocol_id text REFERENCES protocols(id), parent_hash text, seq int NOT NULL,
  title text NOT NULL, body jsonb NOT NULL, author text, created_at timestamptz DEFAULT now(), embedding ${vec});
CREATE TABLE IF NOT EXISTS assignments (id text PRIMARY KEY, protocol_id text, hash text, data jsonb NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, kind text, assignment_id text, data jsonb NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS findings (
  id bigserial PRIMARY KEY, run_id text, operator text, sop_line int, step text, status text, reason text,
  seeded boolean DEFAULT false, created_at timestamptz DEFAULT now(), embedding ${vec});
CREATE INDEX IF NOT EXISTS findings_step_status ON findings (sop_line, status, created_at);
CREATE TABLE IF NOT EXISTS calibration (
  id bigserial PRIMARY KEY, node text, prompt_hash text, prompt_version text, model text, state text,
  correct int, total int, per_status jsonb, confusion jsonb, baseline jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS sealed_records (
  run_id text PRIMARY KEY, bucket text, key text, version_id text, sha256 text, lock_mode text, packet jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS tamper_log (id bigserial PRIMARY KEY, run_id text, attempt jsonb, created_at timestamptz DEFAULT now());
`;

async function init() {
  if (!usePg()) { J(); return { mode: 'json' }; }
  const { Pool } = require('pg');
  const ca = process.env.DATABASE_CA_FILE && fs.existsSync(process.env.DATABASE_CA_FILE) ? fs.readFileSync(process.env.DATABASE_CA_FILE, 'utf8') : null;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/, ''),
    ssl: process.env.DATABASE_SSL === '0' ? false : (ca ? { ca } : { rejectUnauthorized: false }),
    max: 5,
  });
  try { await pool.query('CREATE EXTENSION IF NOT EXISTS vector'); hasVector = true; }
  catch (e) { console.warn('pgvector unavailable, storing embeddings as real[]:', e.message); }
  await pool.query(SCHEMA(hasVector ? 'vector(4096)' : 'real[]'));
  return { mode: 'postgres', vector: hasVector };
}
const q = (sql, args) => pool.query(sql, args);
const vecLit = v => (v ? (hasVector ? '[' + v.join(',') + ']' : v) : null);
const mode = () => ({ mode: pool ? 'postgres' : 'json', vector: hasVector });

// ---------------- protocols / versions ----------------
async function listProtocols() {
  if (!pool) return J().protocols;
  const ps = (await q('SELECT id, title FROM protocols ORDER BY created_at')).rows;
  const vs = (await q('SELECT hash, protocol_id, parent_hash, title, body, author, created_at FROM versions ORDER BY seq')).rows;
  return ps.map(p => ({ ...p, versions: vs.filter(v => v.protocol_id === p.id).map(v => ({ hash: v.hash, parentHash: v.parent_hash, title: v.title, steps: v.body, author: v.author, createdAt: v.created_at })) }));
}
async function getProtocol(id) { return (await listProtocols()).find(p => p.id === id) || null; }
async function saveVersion(protocolId, title, version, embedding) {
  if (!pool) {
    let p = J().protocols.find(x => x.id === protocolId);
    if (!p) { p = { id: protocolId, title, versions: [] }; J().protocols.push(p); }
    p.title = title; p.versions.push(version); saveJ(); return p;
  }
  await q('INSERT INTO protocols (id, title) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title', [protocolId, title]);
  const seq = (await q('SELECT count(*)::int n FROM versions WHERE protocol_id=$1', [protocolId])).rows[0].n;
  await q('INSERT INTO versions (hash, protocol_id, parent_hash, seq, title, body, author, embedding) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (hash) DO NOTHING',
    [version.hash, protocolId, version.parentHash, seq, version.title, JSON.stringify(version.steps), version.author, vecLit(embedding)]);
  return getProtocol(protocolId);
}

// ---------------- assignments ----------------
async function listAssignments() {
  if (!pool) return J().assignments;
  return (await q('SELECT data FROM assignments ORDER BY created_at')).rows.map(r => r.data);
}
async function getAssignment(id) {
  if (!pool) return J().assignments.find(a => a.id === id) || null;
  return (await q('SELECT data FROM assignments WHERE id=$1', [id])).rows[0]?.data || null;
}
async function addAssignment(a) {
  if (!pool) { J().assignments.push(a); saveJ(); return a; }
  await q('INSERT INTO assignments (id, protocol_id, hash, data) VALUES ($1,$2,$3,$4)', [a.id, a.protocolId, a.hash, a]);
  return a;
}
async function updateAssignment(id, patch) {
  const a = { ...(await getAssignment(id)), ...patch };
  if (!pool) { const i = J().assignments.findIndex(x => x.id === id); J().assignments[i] = a; saveJ(); return a; }
  await q('UPDATE assignments SET data=$2 WHERE id=$1', [id, a]);
  return a;
}

// ---------------- runs ----------------
async function addRun(run) {
  if (!pool) { J().runs.push(run); saveJ(); return run; }
  await q('INSERT INTO runs (id, kind, assignment_id, data) VALUES ($1,$2,$3,$4)', [run.id, run.kind || 'integrity', run.assignmentId || null, run]);
  return run;
}
async function getRun(id) {
  if (!pool) return J().runs.find(r => r.id === id) || null;
  return (await q('SELECT data FROM runs WHERE id=$1', [id])).rows[0]?.data || null;
}
async function updateRun(id, patch) {
  const r = { ...(await getRun(id)), ...patch };
  if (!pool) { const i = J().runs.findIndex(x => x.id === id); J().runs[i] = r; saveJ(); return r; }
  await q('UPDATE runs SET data=$2 WHERE id=$1', [id, r]);
  return r;
}
async function listRuns(kind) {
  if (!pool) return J().runs.filter(r => !kind || (r.kind || 'integrity') === kind);
  return (await q('SELECT data FROM runs WHERE ($1::text IS NULL OR kind=$1) ORDER BY created_at', [kind || null])).rows.map(r => r.data);
}

// ---------------- findings memory (pgvector) ----------------
async function addFindings(runId, operator, findings, embeddings = [], { seeded = false, createdAt = null } = {}) {
  if (!pool) {
    findings.forEach((f, i) => J().findings.push({ run_id: runId, operator, sop_line: f.sop_line, step: f.sop_text || f.sop_quote, status: f.status, reason: f.reason, seeded, created_at: createdAt || new Date().toISOString() }));
    saveJ(); return;
  }
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    await q('INSERT INTO findings (run_id, operator, sop_line, step, status, reason, seeded, created_at, embedding) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9)',
      [runId, operator, f.sop_line, f.sop_text || f.sop_quote, f.status, f.reason || null, seeded, createdAt, vecLit(embeddings[i])]);
  }
}

// "Step 4 not documented 3x this month, 2 operators". Exact step+status match over 30 days,
// plus (when embeddings exist) nearest past findings by cosine distance.
async function similarFindings(f, embedding, excludeRunId) {
  if (f.status === 'verified') return null;
  if (!pool) {
    const since = Date.now() - 30 * 864e5;
    const rows = J().findings.filter(x => x.sop_line === f.sop_line && x.status === f.status && x.run_id !== excludeRunId && Date.parse(x.created_at) >= since);
    return { count: rows.length, operators: new Set(rows.map(r => r.operator)).size, via: 'step match (json)' };
  }
  const agg = (await q(`SELECT count(*)::int count, count(DISTINCT operator)::int operators FROM findings
    WHERE sop_line=$1 AND status=$2 AND run_id IS DISTINCT FROM $3 AND created_at > now() - interval '30 days'`, [f.sop_line, f.status, excludeRunId || null])).rows[0];
  let nearest = [];
  if (embedding && hasVector) {
    nearest = (await q(`SELECT step, status, operator, created_at, 1 - (embedding <=> $1::vector) AS similarity FROM findings
      WHERE embedding IS NOT NULL AND status <> 'verified' AND run_id IS DISTINCT FROM $2 ORDER BY embedding <=> $1::vector LIMIT 3`, [vecLit(embedding), excludeRunId || null])).rows;
  }
  return { ...agg, nearest, via: hasVector && embedding ? 'pgvector + step match' : 'step match' };
}

// ---------------- calibration ----------------
async function saveCalibration(row) {
  if (!pool) { J().calibration.push({ ...row, created_at: new Date().toISOString() }); saveJ(); return; }
  await q('INSERT INTO calibration (node, prompt_hash, prompt_version, model, state, correct, total, per_status, confusion, baseline) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [row.node, row.prompt_hash, row.prompt_version, row.model, row.state, row.correct, row.total, row.per_status, row.confusion, row.baseline]);
}
async function latestCalibration(promptHash) {
  if (!pool) return [...J().calibration].reverse().find(c => c.prompt_hash === promptHash && c.state !== 'STALE') || null;
  return (await q(`SELECT * FROM calibration WHERE prompt_hash=$1 AND state <> 'STALE' ORDER BY created_at DESC LIMIT 1`, [promptHash])).rows[0] || null;
}

// ---------------- sealed records ----------------
async function saveSeal(row) {
  if (!pool) { J().seals.push({ ...row, created_at: new Date().toISOString() }); saveJ(); return; }
  await q('INSERT INTO sealed_records (run_id, bucket, key, version_id, sha256, lock_mode, packet) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [row.run_id, row.bucket, row.key, row.version_id, row.sha256, row.lock_mode, row.packet]);
}
async function getSeal(runId) {
  if (!pool) return J().seals.find(s => s.run_id === runId) || null;
  return (await q('SELECT * FROM sealed_records WHERE run_id=$1', [runId])).rows[0] || null;
}
async function logTamper(runId, attempt) {
  if (!pool) { J().tamper.push({ run_id: runId, attempt, created_at: new Date().toISOString() }); saveJ(); return; }
  await q('INSERT INTO tamper_log (run_id, attempt) VALUES ($1,$2)', [runId, attempt]);
}

// ---------------- demo reset ----------------
async function resetDemo() {
  if (!pool) { jsonDb = EMPTY(); saveJ(); return; }
  await q(`TRUNCATE assignments, runs, findings, versions, protocols RESTART IDENTITY CASCADE`);
}

module.exports = {
  init, mode, listProtocols, getProtocol, saveVersion, listAssignments, getAssignment, addAssignment, updateAssignment,
  addRun, getRun, updateRun, listRuns, addFindings, similarFindings, saveCalibration, latestCalibration,
  saveSeal, getSeal, logTamper, resetDemo, query: (...a) => q(...a),
};
