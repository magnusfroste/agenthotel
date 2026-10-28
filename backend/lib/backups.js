// Nightly backups of every guest's memory (2026-10-28). An agent's memory is
// its harness's own files in its volumes, which is what lets it move between
// hotels; until now the only copy was the one an operator remembered to
// export. Each night every guest gets a backup: a folder holding agent.json
// (what the export carries) and one .tar.gz per volume, made while the
// guest's containers are paused for the seconds the tar takes, so the copy is
// consistent without a restart. The newest few stay on the host; with an S3
// bucket configured (Hetzner Object Storage, Cloudflare R2, Backblaze, MinIO:
// any S3 API) each backup is uploaded too and the bucket keeps more.
//
// What here does not touch Docker or the network is pure and tested.

const fs = require('fs');
const path = require('path');

const BACKUP_ROOT = process.env.AGENTHOTEL_BACKUP_ROOT || '/data/backups';

const DEFAULTS = {
  backup_enabled: 'false',
  backup_hour: '3',            // UTC
  backup_keep_local: '3',
  backup_keep_remote: '14',
  backup_s3_endpoint: '',
  backup_s3_region: '',
  backup_s3_bucket: '',
  backup_s3_access_key: '',
  backup_s3_prefix: 'agenthotel',
};
const SECRET_KEY = 'backup_s3_secret_key';
const KEYS = [...Object.keys(DEFAULTS), SECRET_KEY];

// A backup's folder name: sortable, and safe as a path and an S3 key.
function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

// Whether tonight's run is due: at or after the hour (UTC), once a day.
function isDue(now, lastRunIso, hour) {
  if (now.getUTCHours() < hour) return false;
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso);
  if (Number.isNaN(last.getTime())) return true;
  return last.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10);
}

// Of a guest's backups (stamps), the ones beyond the newest `keep`.
function beyondKeep(stamps, keep) {
  const n = Math.max(1, parseInt(keep, 10) || 1);
  return [...stamps].filter(s => STAMP_RE.test(s)).sort().reverse().slice(n);
}

// The settings, with defaults, numbers parsed, and whether S3 is complete.
function readSettings(get) {
  const s = {};
  for (const k of KEYS) s[k] = get(k) ?? DEFAULTS[k] ?? '';
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  return {
    enabled: s.backup_enabled === 'true',
    hour: Math.min(23, Math.max(0, int(s.backup_hour, 3))),
    keepLocal: Math.max(1, int(s.backup_keep_local, 3)),
    keepRemote: Math.max(1, int(s.backup_keep_remote, 14)),
    s3: {
      endpoint: s.backup_s3_endpoint.trim(),
      region: s.backup_s3_region.trim() || 'auto',
      bucket: s.backup_s3_bucket.trim(),
      accessKey: s.backup_s3_access_key.trim(),
      secretKey: s[SECRET_KEY],
      prefix: s.backup_s3_prefix.trim().replace(/^\/+|\/+$/g, ''),
    },
    get s3Configured() {
      const c = this.s3;
      return Boolean(c.endpoint && c.bucket && c.accessKey && c.secretKey);
    },
  };
}

// The S3 key prefix of one guest's backups.
function remotePrefix(prefix, agentName) {
  return [prefix, agentName].filter(Boolean).join('/') + '/';
}

// What a guest has on this host: [{ stamp, bytes, files }], newest first.
function listLocal(agentName, root = BACKUP_ROOT) {
  const dir = path.join(root, agentName);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.filter(n => STAMP_RE.test(n)).sort().reverse().map(n => {
    const files = fs.readdirSync(path.join(dir, n));
    const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, n, f)).size, 0);
    return { stamp: n, bytes, files };
  });
}

// ---- S3 -----------------------------------------------------------------

function s3Client(c) {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    endpoint: c.endpoint.startsWith('http') ? c.endpoint : `https://${c.endpoint}`,
    region: c.region || 'auto',
    credentials: { accessKeyId: c.accessKey, secretAccessKey: c.secretKey },
    // Hetzner, R2 and MinIO address buckets by path, not by subdomain.
    forcePathStyle: true,
  });
}

// Writes and removes a small object: the credentials, the bucket and the
// permission to write and delete, all in one try.
async function testS3(c) {
  const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = s3Client(c);
  const Key = `${remotePrefix(c.prefix, '.agenthotel-test')}${Date.now()}.txt`;
  await client.send(new PutObjectCommand({ Bucket: c.bucket, Key, Body: 'AgentHotel backup test\n' }));
  await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key }));
  return { ok: true };
}

// Uploads one backup folder, file by file (multipart for the large ones).
async function uploadBackup(c, agentName, backupStamp, dir) {
  const { Upload } = require('@aws-sdk/lib-storage');
  const client = s3Client(c);
  let bytes = 0;
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    bytes += fs.statSync(file).size;
    await new Upload({
      client,
      params: { Bucket: c.bucket, Key: `${remotePrefix(c.prefix, agentName)}${backupStamp}/${f}`, Body: fs.createReadStream(file) },
      partSize: 16 * 1024 * 1024,
      queueSize: 2,
    }).done();
  }
  return bytes;
}

// The stamps of a guest's backups in the bucket.
async function listRemote(c, agentName) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const client = s3Client(c);
  const Prefix = remotePrefix(c.prefix, agentName);
  const stamps = new Set();
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix, ContinuationToken }));
    for (const o of page.Contents || []) {
      const s = o.Key.slice(Prefix.length).split('/')[0];
      if (STAMP_RE.test(s)) stamps.add(s);
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return [...stamps];
}

// Removes a guest's backups in the bucket beyond the newest `keep`.
async function pruneRemote(c, agentName, keep) {
  const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const client = s3Client(c);
  const drop = beyondKeep(await listRemote(c, agentName), keep);
  for (const s of drop) {
    const Prefix = `${remotePrefix(c.prefix, agentName)}${s}/`;
    const page = await client.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix }));
    const Objects = (page.Contents || []).map(o => ({ Key: o.Key }));
    if (Objects.length) await client.send(new DeleteObjectsCommand({ Bucket: c.bucket, Delete: { Objects } }));
  }
  return drop;
}

module.exports = {
  BACKUP_ROOT, DEFAULTS, SECRET_KEY, KEYS, STAMP_RE,
  stamp, isDue, beyondKeep, readSettings, remotePrefix, listLocal,
  testS3, uploadBackup, listRemote, pruneRemote,
};
