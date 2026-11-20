// Akamai Object Storage (S3-compatible, us-ord).
//  a) capture bucket: phone uploads straight to storage via a presigned PUT (10 min, content-type signed)
//  b) lock bucket: Object Lock COMPLIANCE, 1-day retention; sealed run packets, always read by versionId
//  c) auditor share: presigned GET of the sealed version, 24 h
const crypto = require('crypto');
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const CFG = {
  endpoint: process.env.S3_ENDPOINT || 'https://us-ord-1.linodeobjects.com',
  region: process.env.S3_REGION || 'us-ord-1',
  accessKeyId: process.env.S3_ACCESS_KEY || '',
  secretAccessKey: process.env.S3_SECRET_KEY || '',
  captureBucket: process.env.S3_CAPTURE_BUCKET || '',
  lockBucket: process.env.S3_LOCK_BUCKET || '',
  // "compliance" (Object Lock) or "versioning" (fallback: versioning + SHA-256 manifest in Postgres)
  lockMode: process.env.S3_LOCK_MODE || 'compliance',
  retentionDays: Number(process.env.S3_LOCK_DAYS || 1),
};
const storageReady = () => Boolean(CFG.accessKeyId && CFG.secretAccessKey && CFG.captureBucket);

let client;
const s3 = () => (client ||= new S3Client({
  endpoint: CFG.endpoint, region: CFG.region,
  credentials: { accessKeyId: CFG.accessKeyId, secretAccessKey: CFG.secretAccessKey },
  // S3-compatible stores reject the SDK's newer default CRC32 checksum headers / query params.
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
}));

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const md5b64 = buf => crypto.createHash('md5').update(buf).digest('base64');
const streamToBuffer = async body => Buffer.from(await body.transformToByteArray());

// ---------- (a) phone capture ----------
// The returned URL is only valid with exactly this Content-Type header.
async function presignPut(key, contentType = 'image/jpeg', expiresIn = 600) {
  const url = await getSignedUrl(s3(), new PutObjectCommand({ Bucket: CFG.captureBucket, Key: key, ContentType: contentType }), {
    expiresIn, signableHeaders: new Set(['content-type', 'host']),
  });
  return { url, key, bucket: CFG.captureBucket, contentType, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}
async function getObjectBuffer(key, bucket = CFG.captureBucket, versionId) {
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  return { buffer: await streamToBuffer(r.Body), contentType: r.ContentType, versionId: r.VersionId };
}
// For Gemma: images must be base64 data URLs (remote URLs return 422).
async function getObjectDataUrl(key) {
  const { buffer, contentType } = await getObjectBuffer(key);
  return `data:${contentType || 'image/jpeg'};base64,${buffer.toString('base64')}`;
}
async function objectExists(key, bucket = CFG.captureBucket) {
  try { await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; } catch { return false; }
}

// ---------- (b) tamper-proof records ----------
async function sealPacket(runId, packet) {
  const body = Buffer.from(JSON.stringify(packet, null, 2));
  const key = `records/${runId}.json`;
  const params = { Bucket: CFG.lockBucket, Key: key, Body: body, ContentType: 'application/json', ContentMD5: md5b64(body) };
  if (CFG.lockMode === 'compliance') {
    params.ObjectLockMode = 'COMPLIANCE';
    params.ObjectLockRetainUntilDate = new Date(Date.now() + CFG.retentionDays * 864e5);
  }
  const r = await s3().send(new PutObjectCommand(params));
  return {
    bucket: CFG.lockBucket, key, versionId: r.VersionId || null, sha256: sha256(body), lockMode: CFG.lockMode,
    retainUntil: params.ObjectLockRetainUntilDate ? params.ObjectLockRetainUntilDate.toISOString() : null,
  };
}

// The "Try to alter this record" button. Two real attempts, never a plain delete-by-key:
//  1) delete the sealed version by versionId -> AccessDenied under COMPLIANCE
//  2) overwrite the same key -> succeeds as a NEW version; we read the stored versionId, re-hash, compare.
async function tamperAttempt(seal) {
  const out = { at: new Date().toISOString() };
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: seal.bucket, Key: seal.key, VersionId: seal.version_id }));
    out.delete = { ok: true, message: 'Delete of the sealed version SUCCEEDED (record not locked)' };
  } catch (e) {
    out.delete = { ok: false, code: e.name || e.Code, httpStatus: e.$metadata?.httpStatusCode, message: e.message };
  }
  try {
    const forged = Buffer.from(JSON.stringify({ forged: true, note: 'all steps verified', at: out.at }));
    const r = await s3().send(new PutObjectCommand({ Bucket: seal.bucket, Key: seal.key, Body: forged, ContentType: 'application/json', ContentMD5: md5b64(forged) }));
    out.overwrite = { ok: true, newVersionId: r.VersionId || null };
  } catch (e) {
    out.overwrite = { ok: false, code: e.name, message: e.message };
  }
  try {
    const { buffer } = await getObjectBuffer(seal.key, seal.bucket, seal.version_id);
    const h = sha256(buffer);
    out.reread = { versionId: seal.version_id, sha256: h, expected: seal.sha256, intact: h === seal.sha256 };
  } catch (e) {
    out.reread = { versionId: seal.version_id, intact: false, error: e.message };
  }
  out.verdict = out.reread.intact
    ? 'Original intact; tamper attempt detected and logged'
    : 'ORIGINAL NOT RECOVERABLE: investigate';
  return out;
}

// ---------- (c) auditor share ----------
async function presignGet(key, { bucket = CFG.lockBucket, versionId, expiresIn = 86400 } = {}) {
  const url = await getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }), { expiresIn });
  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

module.exports = { CFG, storageReady, s3, presignPut, presignGet, getObjectBuffer, getObjectDataUrl, objectExists, sealPacket, tamperAttempt, sha256 };
