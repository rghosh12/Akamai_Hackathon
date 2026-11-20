const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const { createApplication } = require('../server');
const { configFromEnv, loadEnvironment } = require('../lib/config');
const { createInference } = require('../lib/inference');
const { createStorage } = require('../lib/storage');
const { checkCitations, localVerify, VERIFY_SCHEMA } = require('../lib/verification');

const sop = 'Step 1. Incubate at 37 C.\nStep 2. Record the temperature.';
const log = 'Incubated at 42 C.\nTemperature not recorded.';
const finding = { sop_line: 1, sop_quote: 'Step 1. Incubate at 37 C.', status: 'contradicted', log_line: 1, log_quote: 'Incubated at 42 C.', reason: '42 C differs from 37 C.' };
const modelResult = { summary: 'Temperature conflict; human review required.', findings: [finding,
  { sop_line: 2, sop_quote: 'Step 2. Record the temperature.', status: 'insufficient_evidence', log_line: 2, log_quote: 'Temperature not recorded.', reason: 'No value documented.' }] };
const modelResponse = result => new Response(JSON.stringify({ id: 'request-test', model: 'qwen3-8-27b',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
const env = { AKAMAI_API_KEY: 'test-only-inference', OBJ_BUCKET: 'test-private-bucket', OBJ_ACCESS_KEY: 'test-only-access', OBJ_SECRET_KEY: 'test-only-secret' };

function memoryS3() {
  const objects = new Map(); const calls = [];
  return { objects, calls, async send(command) {
    const { Key, Body } = command.input; calls.push(command);
    switch (command.constructor.name) {
      case 'PutObjectCommand': objects.set(Key, Body); return {};
      case 'GetObjectCommand':
        if (!objects.has(Key)) throw Object.assign(new Error('provider-secret-must-not-escape'), { name: 'NoSuchKey' });
        return { Body: Readable.from([objects.get(Key)]), ContentLength: Buffer.byteLength(objects.get(Key)) };
      case 'DeleteObjectCommand': objects.delete(Key); return {};
      case 'ListObjectsV2Command': return { Contents: [...objects.keys()].filter(k => k.startsWith(command.input.Prefix)).map(Key => ({ Key, Size: 50, LastModified: new Date() })) };
    }
    throw new Error('Unexpected command');
  } };
}
async function app(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labstrata-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const application = createApplication({ ...options, env: { DATA_DIR: dataDir, ...options.env } });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { ...application, request, base, dataDir };
}

test('workshop model alias, existing override, endpoint validation, and secret files', t => {
  assert.equal(configFromEnv({}).inference.model, 'qwen3-8-27b');
  assert.equal(configFromEnv({ CHAT_MODEL: 'workshop' }).inference.model, 'workshop');
  assert.equal(configFromEnv({ CHAT_MODEL: 'workshop', AKAMAI_MODEL: 'existing' }).inference.model, 'existing');
  for (const bad of ['http://example.test/v1', 'https://user:password@example.test/v1', 'https://example.test/?key=value']) {
    assert.throws(() => configFromEnv({ AKAMAI_BASE_URL: bad }), /HTTPS URL without credentials/);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labstrata-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'AKAMAI_API_KEY'), 'file-test-key\n');
  assert.equal(configFromEnv({ CREDENTIALS_DIRECTORY: dir }).inference.apiKey, 'file-test-key');
  fs.writeFileSync(path.join(dir, '.env'), 'CHAT_MODEL="local-model"\nAKAMAI_API_KEY=local-test-key\n');
  assert.equal(loadEnvironment({ CHAT_MODEL: 'override' }, path.join(dir, '.env')).CHAT_MODEL, 'override');
  assert.equal(loadEnvironment({ NODE_ENV: 'production' }, path.join(dir, '.env')).AKAMAI_API_KEY, undefined);
});

test('explicit contradiction survives citation validation; absence stays insufficient evidence', () => {
  const findings = checkCitations(modelResult.findings, sop, log);
  assert.deepEqual(findings.map(f => f.status), ['contradicted', 'insufficient_evidence']);
  assert.equal(findings[0].log_text, 'Incubated at 42 C.');
});
for (const [name, changes] of Object.entries({
  'fabricated log ID': { log_line: 999 }, 'fabricated quote': { log_quote: 'Everything complied.' },
  'uncited positive claim': { status: 'documented', log_line: null, log_quote: null },
  'unknown status': { status: 'passed' }, 'string citation ID': { log_line: '1' },
})) test(`${name} becomes needs_review and never renders invented evidence`, () => {
  const result = checkCitations([{ ...finding, ...changes }], sop, log);
  assert.equal(result[0].status, 'needs_review');
  assert.equal(result[1].status, 'needs_review');
  assert.notEqual(result[0].log_text, 'Everything complied.');
});
test('unknown and duplicate requirements never pass', () => {
  assert.equal(checkCitations([finding, finding], sop, log)[0].status, 'needs_review');
  assert.equal(checkCitations([finding, { ...finding, sop_line: 999 }], sop, log)[0].status, 'needs_review');
});
test('offline matcher never claims a contradiction is documented or missing evidence proves skipping', () => {
  for (const text of [log, 'Incubation complete.', 'No relevant documentation.']) {
    const result = localVerify(sop, text);
    assert.ok(result.findings.every(f => ['needs_review', 'insufficient_evidence'].includes(f.status)));
  }
});

test('inference sends workshop format and retries only unsupported structured output', async () => {
  const requests = [];
  const inference = createInference(configFromEnv(env).inference, async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return requests.length === 1 ? new Response('response_format json_schema unsupported', { status: 400 }) : modelResponse(modelResult);
  });
  const result = await inference.call('system', 'user', VERIFY_SCHEMA);
  assert.equal(requests[0].url, 'https://api.akamai-inference.com/v1/chat/completions');
  assert.equal(requests[0].body.model, 'qwen3-8-27b');
  assert.equal(requests[0].body.response_format.type, 'json_schema');
  assert.equal(requests[1].body.response_format, undefined);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(result.meta.requestId, 'request-test');
  assert.equal(inference.health.status, 'operational');
});
for (const status of [400, 401, 403, 429, 500]) test(`HTTP ${status} is sanitized without retry`, async () => {
  let calls = 0;
  const inference = createInference(configFromEnv(env).inference, async () => { calls++; return new Response('private-provider-response', { status }); });
  await assert.rejects(inference.call('system', 'user', VERIFY_SCHEMA), e => e.message.includes(`HTTP ${status}`) && !e.message.includes('private-provider-response'));
  assert.equal(calls, 1); assert.equal(inference.health.status, 'error');
});
test('truncated, malformed, and timed-out inference fails safely', async () => {
  for (const response of [new Response('{bad json'), new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }))]) {
    const inference = createInference(configFromEnv(env).inference, async () => response);
    await assert.rejects(inference.call('s', 'u', VERIFY_SCHEMA), /incomplete|could not be processed/);
  }
  const inference = createInference({ ...configFromEnv(env).inference, timeoutMs: 5 }, async (_, { signal }) => {
    await new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('late')), 100); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
  });
  await assert.rejects(inference.call('s', 'u', VERIFY_SCHEMA), /timed out/);
});

test('existing protocol versions, assignments, hash mismatch, and offline API still work', async t => {
  const { request, hashOf } = await app(t);
  const first = (await request('/api/protocols')).body[0];
  const v1 = first.versions[0];
  const assignment = (await request('/api/assignments', { protocolId: first.id, hash: v1.hash, assignee: 'Tester' })).body;
  const changed = structuredClone(v1.steps); changed[0].label = 'Changed instruction';
  const saved = (await request('/api/protocols', { id: first.id, title: first.title, steps: changed })).body;
  assert.equal(saved.version.parentHash, v1.hash);
  assert.equal(saved.protocol.versions[0].hash, v1.hash);
  assert.equal(hashOf(first.title, v1.steps), v1.hash);
  const run = (await request('/api/runs', { assignmentId: assignment.id, title: first.title, steps: changed, answers: [] })).body;
  assert.equal(run.integrity.match, false); assert.equal(run.integrity.analysis.engine, 'local');
  assert.equal((await request('/api/assignment?id=' + assignment.id)).body.version.hash, v1.hash);
  const review = (await request('/api/verify', { sop, log })).body;
  assert.equal(review.engine, 'local'); assert.ok(review.evidenceId); assert.equal(review.human_review_required, true);
  assert.equal((await request('/api/evidence', { id: review.evidenceId })).status, 503);
});

test('verify → private save/read-back → restart with empty local data → reopen without inference', async t => {
  const s3 = memoryS3(); let calls = 0;
  const original = await app(t, { env, storageClient: s3, fetchImpl: async () => { calls++; return modelResponse(modelResult); } });
  assert.equal((await original.request('/health')).body.inference.status, 'configured');
  const review = (await original.request('/api/verify', { sop, log })).body;
  assert.equal(review.engine, 'akamai'); assert.equal(review.findings[0].status, 'contradicted');
  const saved = await original.request('/api/evidence', { id: review.evidenceId, result: { forged: true } });
  assert.equal(saved.body.verified, true);
  assert.equal(s3.calls.find(c => c.constructor.name === 'PutObjectCommand').input.ACL, undefined);
  const reopenedApp = await app(t, { env: { ...env, AKAMAI_API_KEY: '' }, storageClient: s3, fetchImpl: () => { throw new Error('Must not call inference'); } });
  const list = (await reopenedApp.request('/api/evidence')).body;
  assert.equal(list.packets[0].id, review.evidenceId);
  const reopened = (await reopenedApp.request('/api/evidence/packet?id=' + review.evidenceId)).body;
  assert.equal(reopened.packet.sop, sop); assert.equal(reopened.packet.log, log);
  assert.equal(reopened.packet.result.meta.requestId, 'request-test');
  assert.equal(calls, 1);
  const config = (await original.request('/api/config')).body;
  assert.equal(config.inference.status, 'operational'); assert.equal(config.object_storage.status, 'operational');
  const visible = JSON.stringify([config, review, saved.body, reopened]);
  for (const secret of [env.AKAMAI_API_KEY, env.OBJ_ACCESS_KEY, env.OBJ_SECRET_KEY]) assert.ok(!visible.includes(secret));
});

test('storage check cleans probe, invalid IDs cannot escape prefix, and failures do not fake persistence', async () => {
  const s3 = memoryS3(); const storage = createStorage(configFromEnv(env).storage, s3);
  assert.equal((await storage.check()).status, 'operational'); assert.equal(s3.objects.size, 0);
  await assert.rejects(storage.get('../secrets'), /Invalid evidence/);
  const failing = createStorage(configFromEnv(env).storage, { send: async () => { throw new Error('secret-provider-payload'); } });
  await assert.rejects(failing.save({ id: crypto.randomUUID() }), error => !error.message.includes('secret-provider-payload'));
  assert.equal(failing.health.status, 'error');
});

test('JSON size/type, cross-origin, static traversal and readiness guards', async t => {
  const { request, base } = await app(t);
  assert.equal((await request('/ready')).status, 200);
  assert.equal((await request('/api/verify', { sop: {}, log })).status, 400);
  assert.equal((await request('/api/verify', { sop: 'x'.repeat(50001), log })).status, 413);
  const badJson = await fetch(base + '/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(badJson.status, 400);
  const cross = await fetch(base + '/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' });
  assert.equal(cross.status, 403);
  assert.equal((await fetch(base + '/%2e%2e%2fserver.js')).status, 404);
  assert.equal((await fetch(base + '/.env')).status, 404);
});

test('protocol edits made while inference is pending survive run submission', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const application = await app(t, { env, fetchImpl: async () => {
    entered(); await new Promise(resolve => { release = resolve; });
    return modelResponse({ changes: [{ step: 1, what_changed: 'Instruction changed.', impact: 'low' }], verdict: 'Review required.' });
  } });
  const request = application.request;
  const p = (await request('/api/protocols')).body[0]; const version = p.versions[0];
  const assignment = (await request('/api/assignments', { protocolId: p.id, hash: version.hash, assignee: 'Tester' })).body;
  const steps = structuredClone(version.steps); steps[0].label = 'Changed';
  const run = request('/api/runs', { assignmentId: assignment.id, title: p.title, steps, answers: [] });
  await waiting;
  await request('/api/protocols', { title: 'Concurrent protocol', steps: [{ type: 'text', label: 'Keep this protocol' }] });
  release();
  assert.equal((await run).body.integrity.analysis.engine, 'akamai');
  assert.equal((await request('/api/protocols')).body.length, 2);
});

test('storage read-back mismatch never reports a successful save', async () => {
  const storage = createStorage(configFromEnv(env).storage, { send: async command => {
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from(['wrong data']) };
    return {};
  } });
  await assert.rejects(storage.save({ id: crypto.randomUUID() }), /round-trip verification failed/);
  assert.equal(storage.health.status, 'error');
});
