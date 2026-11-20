const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCitations, coverageGuard, localVerify, verify } = require('../lib/verify');

const sop = 'PPE: Wear gloves.\nStep 1. Record temperature.\nStep 4. Balance tubes and record each tube mass.';
test('citation check requires a real, substantial log quote for verified findings', () => {
  const findings = checkCitations([{ sop_line: 2, sop_quote: 'Record temperature.', status: 'verified', log_line: 1, log_quote: 'short', reason: '' }], sop, 'Temperature was 4 C.');
  assert.equal(findings[0].status, 'needs_review');
});
test('coverage guard adds a finding for a skipped required line', () => {
  const findings = coverageGuard([{ sop_line: 1, sop_quote: 'PPE: Wear gloves.', status: 'missed', log_line: null, log_quote: null, reason: '' }], sop, '');
  assert.equal(findings.length, 3);
  assert.equal(findings.find(f => f.sop_line === 2).reason, 'model skipped this step');
});
test('tube masses over tolerance override the model as deviation', () => {
  const findings = coverageGuard([], sop, 'Loaded positions 1 & 13: 1.0 g / 1.3 g.');
  assert.equal(findings.find(f => f.sop_line === 3).status, 'deviation');
});
test('missing verified citation becomes needs_review', async () => {
  const result = await verify(sop, 'Temperature was 4 C.', { ready: () => true, call: async () => ({ json: { findings: [{ sop_line: 2, sop_quote: 'Record temperature.', status: 'verified', log_line: 1, log_quote: null, reason: 'done' }] } }) });
  assert.equal(result.findings.find(f => f.sop_line === 2).status, 'needs_review');
});
test('tube mass tolerance accepts a floating-point boundary of 0.1 g', () => {
  const findings = coverageGuard([], sop, 'Loaded positions 1 & 13: 1.5 g / 1.6 g.');
  assert.equal(findings.find(f => f.sop_line === 3).status, 'verified');
});
test('tube masses on separate position lines are paired with their opposite rotor positions', () => {
  const findings = coverageGuard([], sop, 'Pos 1: 1.500 g\nPos 13: 1.700 g');
  assert.equal(findings.find(f => f.sop_line === 3).status, 'deviation');
});
test('local verification ignores a leading timestamp when a recorded value is missing', () => {
  const result = localVerify('Step 1. Inspect the rotor and record the rotor serial number.', '14:31 Rotor looks fine.');
  assert.equal(result.findings[0].status, 'unverifiable');
});
test('model output is normalized, deduplicated, and rejects unknown statuses', async () => {
  const result = await verify(sop, 'Temperature was 4 C.', { ready: () => true, call: async () => ({ json: { findings: [{ sop_line: '2', status: 'invented', log_line: '1' }, { sop_line: '2', status: 'verified', log_line: '1' }] } }) });
  const finding = result.findings.find(f => f.sop_line === 2);
  assert.equal(finding.status, 'needs_review');
  assert.equal(finding.log_line, 1);
  assert.equal(result.findings.filter(f => f.sop_line === 2).length, 1);
});
