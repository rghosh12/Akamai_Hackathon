// Uses only synthetic data. Prints statuses, never credentials, provider bodies, or signed URLs.
// With --url, checks an already-running service through the SSH tunnel.
const { createApplication } = require('../server');
const { loadEnvironment } = require('../lib/config');
const { once } = require('node:events');
async function main() {
  let application;
  const urlIndex = process.argv.indexOf('--url');
  let base = urlIndex >= 0 ? process.argv[urlIndex + 1] : null;
  if (!base) {
    application = createApplication({ env: loadEnvironment() });
    application.server.listen(0, '127.0.0.1');
    await once(application.server, 'listening');
    base = `http://127.0.0.1:${application.server.address().port}`;
  }
  const request = async (route, body) => {
    const response = await fetch(new URL(route, base), body === undefined ? { signal: AbortSignal.timeout(60000) } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error('check failed');
    return response.json();
  };
  try {
    const health = await request('/health');
    if (!health.inference.configured || !health.object_storage.configured) {
      console.error('Live check requires configured inference and Object Storage. No credentials were printed.');
      process.exitCode = 1; return;
    }
    const storage = await request('/api/storage/check', {});
    if (storage.status !== 'operational') throw new Error('storage check failed');
    console.log('PASS Object Storage: write/read/delete');
    const result = await request('/api/verify', {
      sop: 'Step 1. Record the measured temperature.', log: 'Measured temperature: 22 C.',
    });
    if (result.engine !== 'akamai' || result.findings.length !== 1 || !result.findings[0].citation_ok || result.findings[0].status !== 'documented') throw new Error('inference check failed');
    console.log('PASS Akamai Inference: live structured response and validated evidence');
    const saved = await request('/api/evidence', { id: result.evidenceId });
    const reopened = await request('/api/evidence/packet?id=' + result.evidenceId);
    if (!saved.verified || reopened.packet.result.meta.requestId !== result.meta.requestId) throw new Error('reopen check failed');
    console.log('PASS evidence: saved and reopened without a second inference request');
    console.log('Synthetic packet retained in your private bucket. Remove it in Cloud Manager when no longer needed.');
  } finally { if (application) await new Promise(resolve => application.server.close(resolve)); }
}
main().catch(() => { console.error('Live check failed. Inspect the app service status; no provider response or secrets were logged.'); process.exitCode = 1; });
