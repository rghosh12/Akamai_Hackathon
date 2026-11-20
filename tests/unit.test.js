// Runs with no keys: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/verify');

const sop = fs.readFileSync(path.join(__dirname, '..', 'demo', 'sop-centrifuge.txt'), 'utf8');
const logA = fs.readFileSync(path.join(__dirname, '..', 'demo', 'log-A-compliant.txt'), 'utf8');
const logB = fs.readFileSync(path.join(__dirname, '..', 'demo', 'log-B-missed-step.txt'), 'utf8');

test('citation check: verified without a real log quote becomes needs_review; fake line dropped', () => {
  const out = V.checkCitations([
    { sop_line: 3, sop_quote: 'PPE: Lab coat', status: 'verified', log_line: 2, log_quote: 'on' },          // quote too short
    { sop_line: 4, sop_quote: 'Step 1.', status: 'verified', log_line: 3, log_quote: 'Calibration OK, due 2027-03-01' },
    { sop_line: 99, sop_quote: 'nope', status: 'verified', log_line: null, log_quote: null },             // nonexistent line
    { sop_line: 4, sop_quote: 'Step 1.', status: 'missed', log_line: null, log_quote: null },             // duplicate
  ], sop, logB);
  assert.equal(out.find(f => f.sop_line === 3).status, 'needs_review');
  assert.equal(out.find(f => f.sop_line === 4).status, 'verified');
  assert.ok(!out.find(f => f.sop_line === 99));
  assert.equal(out.filter(f => f.sop_line === 4).length, 1);
});

test('coverage guard: every requirement line gets exactly one finding', () => {
  const out = V.checkCitations([{ sop_line: 4, sop_quote: 'Step 1.', status: 'missed', log_line: null, log_quote: null }], sop, logB);
  assert.deepEqual(out.map(f => f.sop_line), V.requirementLines(sop));
  assert.equal(out.find(f => f.sop_line === 7).status, 'needs_review');
  assert.match(out.find(f => f.sop_line === 7).reason, /skipped/);
});

test('tube-mass tolerance is checked by code; "Loaded 4 tubes" with no masses never passes', () => {
  const a = V.numberChecks(sop, logA).find(c => c.check.includes('0.1 g'));
  assert.equal(a.status, 'verified');
  const b = V.numberChecks(sop, logB).find(c => c.sop_line === 7);
  assert.equal(b.status, 'missed');
  const bad = V.numberChecks(sop, logA.replace('1.509 g', '1.309 g')).find(c => c.sop_line === 7);
  assert.equal(bad.status, 'deviation');
  const forced = V.applyNumberChecks([{ sop_line: 7, status: 'verified', reason: 'model' }], V.numberChecks(sop, logB));
  assert.equal(forced[0].status, 'missed');
});

test('unreadable line: missing temperature value is unverifiable, never guessed', () => {
  const t = V.numberChecks(sop, logB).find(c => c.check.includes('temperature'));
  assert.equal(t.status, 'unverifiable');
});
