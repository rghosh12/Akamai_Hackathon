const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCitations, coverageGuard, localVerify, verify } = require('../lib/verify');

const sop = 'PPE: Wear gloves.\nStep 1. Record temperature.\nStep 4. Balance tubes and record each tube mass.';
test('citation check requires a real, substantial log quote for verified findings', () => {
  const findings = checkCitations([{ sop_line: 2, sop_quote: 'Record temperature.', status: 'verified', log_line: 1, log_quote: 'short', reason: '' }], sop, 'Temperature was 4 C.');
  assert.equal(findings[0].status, 'needs_review');
});
test('local verification ignores a leading timestamp when a recorded value is missing', () => {
  const result = localVerify('Step 1. Inspect the rotor and record the rotor serial number.', '14:31 Rotor looks fine.');
  assert.equal(result.findings[0].status, 'unverifiable');
});
