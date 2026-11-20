const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const { createStorage } = require('../lib/storage');

test('real AWS SDK signs private path-style S3 PUT/GET/list/delete with compatible checksums', async t => {
  const objects = new Map(); const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks); const url = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    if (req.method === 'PUT') { objects.set(url.pathname, body); res.end(); }
    else if (req.method === 'DELETE') { objects.delete(url.pathname); res.writeHead(204).end(); }
    else if (url.searchParams.get('list-type') === '2') {
      res.setHeader('Content-Type', 'application/xml');
      const contents = [...objects.keys()].map(key => `<Contents><Key>${key.replace('/private-bucket/', '')}</Key><Size>${objects.get(key).length}</Size><LastModified>2026-11-20T20:00:00Z</LastModified></Contents>`).join('');
      res.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    } else if (objects.has(url.pathname)) { res.setHeader('Content-Length', objects.get(url.pathname).length); res.end(objects.get(url.pathname)); }
    else { res.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  // HTTP is only injected into this local transport fixture; production env validation requires HTTPS.
  const storage = createStorage({ endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1', bucket: 'private-bucket', accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' });
  t.after(() => storage.close());
  await storage.check(); assert.equal(objects.size, 0);
  const packet = { id: randomUUID(), schema_version: 1, sop: 'SOP', log: 'Log', result: { findings: [] } };
  await storage.save(packet);
  assert.deepEqual(await storage.get(packet.id), packet);
  assert.equal((await storage.list()).packets[0].id, packet.id);
  for (const request of requests) {
    assert.ok(request.path.startsWith('/private-bucket/'));
    assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(request.headers['x-amz-acl'], undefined);
    if (request.method === 'PUT') {
      assert.equal(request.headers['x-amz-sdk-checksum-algorithm'], undefined);
      assert.equal(request.headers['x-amz-checksum-crc32'], undefined);
      assert.equal(request.headers['x-amz-content-sha256'], createHash('sha256').update(request.body).digest('hex'));
      assert.equal(Number(request.headers['content-length']), request.body.length);
    }
  }
});
