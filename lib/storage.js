const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

class StorageError extends Error {
  constructor(message, code = 502) { super(message); this.code = code; }
}
const PREFIX = 'labstrata/evidence/';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createStorage(config, injectedClient) {
  const configured = Boolean(config.bucket && config.accessKeyId && config.secretAccessKey);
  const partial = Boolean(config.bucket || config.accessKeyId || config.secretAccessKey);
  const health = { configured, status: configured ? 'configured' : partial ? 'incomplete' : 'not_configured', lastSuccessAt: null };
  const client = injectedClient || (configured ? new S3Client({
    endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
  }) : null);
  async function send(Command, input) {
    if (!configured) throw new StorageError('Object Storage is not fully configured', 503);
    try { return await client.send(new Command({ Bucket: config.bucket, ...input }), { abortSignal: AbortSignal.timeout(20000) }); }
    catch (error) {
      health.status = 'error';
      if (error.name === 'NoSuchKey') throw new StorageError('Evidence packet not found', 404);
      throw new StorageError('Object Storage request failed; check endpoint, bucket, and bucket-scoped permissions');
    }
  }
  const key = id => {
    if (!ID.test(id)) throw new StorageError('Invalid evidence packet ID', 400);
    return `${PREFIX}${id}.json`;
  };
  async function readBody(response) {
    try {
      if (response.ContentLength > 2_000_000) throw new Error();
      let size = 0; const chunks = [];
      for await (const chunk of response.Body) {
        const buffer = Buffer.from(chunk); size += buffer.length;
        if (size > 2_000_000) throw new Error();
        chunks.push(buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch { health.status = 'error'; throw new StorageError('Object Storage returned an unreadable or oversized packet'); }
  }
  const success = () => Object.assign(health, { status: 'operational', lastSuccessAt: new Date().toISOString() });
  async function putAndRead(Key, text) {
    await send(PutObjectCommand, { Key, Body: text, ContentType: 'application/json', ContentLength: Buffer.byteLength(text) });
    const actual = await readBody(await send(GetObjectCommand, { Key }));
    if (actual !== text) { health.status = 'error'; throw new StorageError('Object Storage round-trip verification failed'); }
    success();
  }
  return {
    health,
    async save(packet) {
      await putAndRead(key(packet.id), JSON.stringify(packet));
      return { id: packet.id, provider: 'Akamai Object Storage', verified: true };
    },
    async get(id) {
      const text = await readBody(await send(GetObjectCommand, { Key: key(id) }));
      try {
        const packet = JSON.parse(text);
        if (packet.id !== id || packet.schema_version !== 1 || typeof packet.sop !== 'string' || typeof packet.log !== 'string' || !Array.isArray(packet.result?.findings)) throw new Error();
        return packet;
      } catch { health.status = 'error'; throw new StorageError('Object Storage returned an invalid evidence packet'); }
    },
    async list(cursor) {
      if (cursor && (typeof cursor !== 'string' || cursor.length > 4096)) throw new StorageError('Invalid list cursor', 400);
      const page = await send(ListObjectsV2Command, { Prefix: PREFIX, MaxKeys: 100, ...(cursor ? { ContinuationToken: cursor } : {}) });
      return { packets: (page.Contents || []).filter(x => ID.test(x.Key.slice(PREFIX.length, -5)) && x.Key.endsWith('.json'))
        .map(x => ({ id: x.Key.slice(PREFIX.length, -5), savedAt: x.LastModified, size: x.Size })), nextCursor: page.NextContinuationToken || null };
    },
    async check() {
      const Key = `labstrata/checks/${crypto.randomUUID()}.json`;
      let uploaded = false;
      try {
        // A real write/read/delete, not a bucket-exists check.
        uploaded = true;
        await putAndRead(Key, JSON.stringify({ check: crypto.randomUUID() }));
      } finally { if (uploaded) await send(DeleteObjectCommand, { Key }); }
      success();
      return { ...health };
    },
    close() { client?.destroy?.(); },
  };
}
module.exports = { createStorage, StorageError };
