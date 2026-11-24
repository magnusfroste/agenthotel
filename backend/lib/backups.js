// Nightly backups of every guest's memory (2026-10-28). An agent's memory is
// its harness's own files in its volumes, which is what lets it move between
// hotels; until now the only copy was the one an operator remembered to
// export. Each night every guest gets a backup: a folder holding agent.json
// (what the export carries) and one .tar.gz per volume. The volume is copied
// as a plain tar while the guest's containers are paused, so the copy is
// consistent without a restart, and compressed after they run again. The
// newest few stay on the host; with an S3 bucket configured (Hetzner Object
// Storage, Cloudflare R2, Backblaze, MinIO: any S3 API) each backup is queued
// for upload too, and the bucket keeps more.
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

// A run that was cut short, to be finished rather than begun again
// (2026-11-24). The run lives in the backend, so anything that restarts it
// stops the run where it is: that night an upgrade at 03:40 stopped it after
// five guests, and the next check ten minutes later began again from the
// first under a new stamp, which also left the host holding two of that
// night's backups for those guests. The record is written after each guest;
// within RESUME_WITHIN_MS it is taken up again under the same stamp, the
// guests already done are skipped, and those that failed are tried again.
const RESUME_WITHIN_MS = 20 * 3600 * 1000;

function resumable(record, now = Date.now()) {
  if (!record) return null;
  let r = record;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_) { return null; } }
  if (!r || !STAMP_RE.test(r.stamp || '') || !Array.isArray(r.results)) return null;
  const at = Date.parse(r.startedAt);
  if (!Number.isFinite(at) || at > now || now - at > RESUME_WITHIN_MS) return null;
  return { ...r, results: r.results.filter(x => x && x.ok && x.name) };
}

// Which of a guest's local backups to delete: those beyond the newest `keep`
// that were verified, and any that never were except the one being written.
// A backup is verified only once every archive matched its volume
// (agent.json's verifiedAt), so one without it is what a cut-short run left
// behind. Counted with the others, three of those could push out the last
// good copy.
// `spare` is the stamp being written, or a list of stamps never to remove:
// that one and those still waiting to be copied to S3 (see the queue below).
function localToRemove(list, keep, spare = null) {
  const keepAlso = new Set([].concat(spare || []));
  const verified = list.filter(x => x.verified).map(x => x.stamp);
  const drop = new Set(beyondKeep(verified, keep));
  for (const x of list) if (!x.verified && STAMP_RE.test(x.stamp)) drop.add(x.stamp);
  for (const st of keepAlso) drop.delete(st);
  return [...drop].sort();
}

// ---- The upload queue (2026-11-24) ----------------------------------------
//
// Copying a backup to S3 is no longer part of the run. On 2026-11-24 the run
// took 96 minutes, most of it waiting on Contabo's bucket: measured that
// morning, a 1 KB PUT took 103 s and 16 MB parts anywhere from 0.9 s to 91 s,
// every one HTTP 200 on the first try, so neither more parallel parts nor
// retries make it faster. An upgrade waits for a backup, so for an hour and a
// half each night the panel could not be upgraded.
//
// Now the run makes the local copies (pause, tar, gzip, check) and puts each
// one on a queue kept in the settings table. Uploads go one backup at a time,
// alongside the next guest's copy; an upgrade does not wait for them, and
// after a restart the queue carries on, skipping files the bucket already
// has. A failed upload is tried again later, a few times, before it is given
// up and reported.

const UPLOAD_ATTEMPTS = 4;
const UPLOAD_RETRY_MS = 15 * 60 * 1000;

function parseQueue(raw) {
  let q = raw;
  if (typeof q === 'string') { try { q = JSON.parse(q); } catch (_) { return []; } }
  return Array.isArray(q) ? q.filter(x => x && x.name && STAMP_RE.test(x.stamp || '')) : [];
}

const sameItem = (a, b) => a.name === b.name && a.stamp === b.stamp;

// The queue with one more backup at the end (once: a resumed run may add it again).
function queueAdd(queue, { name, stamp: st }, now = Date.now()) {
  const q = parseQueue(queue);
  if (q.some(x => sameItem(x, { name, stamp: st }))) return q;
  return [...q, { name, stamp: st, queuedAt: now, attempts: 0 }];
}

function queueRemove(queue, item) {
  return parseQueue(queue).filter(x => !sameItem(x, item));
}

// The next backup to upload: the first in line that is not waiting to be
// tried again.
function nextUpload(queue, now = Date.now()) {
  return parseQueue(queue).find(x => !x.notBefore || x.notBefore <= now) || null;
}

// After a failed upload: back in line with a later time, or, after
// UPLOAD_ATTEMPTS, out of it (gaveUp).
function afterFailure(queue, item, error, now = Date.now()) {
  const q = parseQueue(queue);
  const i = q.findIndex(x => sameItem(x, item));
  if (i < 0) return { queue: q, gaveUp: true };
  const attempts = (q[i].attempts || 0) + 1;
  if (attempts >= UPLOAD_ATTEMPTS) return { queue: q.filter((_, j) => j !== i), gaveUp: true };
  const next = [...q];
  next[i] = { ...q[i], attempts, error: String(error).slice(0, 300), notBefore: now + UPLOAD_RETRY_MS * attempts };
  return { queue: next, gaveUp: false };
}

// The stamps of one guest still waiting, which its local pruning must spare.
function queuedStamps(queue, name) {
  return parseQueue(queue).filter(x => x.name === name).map(x => x.stamp);
}

// What became of each upload, by stamp then guest: { s3, seconds, at }. Only
// the newest few stamps are kept.
function recordUpload(map, st, name, result, keepStamps = 3) {
  let m = map;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { m = {}; } }
  const out = { ...(m && typeof m === 'object' ? m : {}) };
  out[st] = { ...(out[st] || {}), [name]: result };
  for (const old of Object.keys(out).sort().reverse().slice(keepStamps)) delete out[old];
  return out;
}

// The last run's summary as the Backups card shows it: each guest's S3 state
// from the upload record or the queue, since the run itself only queued it.
function withUploads(summary, uploaded, queue) {
  if (!summary || !Array.isArray(summary.results)) return summary;
  let m = uploaded;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { m = {}; } }
  const done = (m && m[summary.stamp]) || {};
  const q = parseQueue(queue);
  return {
    ...summary,
    results: summary.results.map(r => {
      if (done[r.name]) return { ...r, s3: done[r.name].s3, uploadSeconds: done[r.name].seconds };
      const waiting = q.find(x => sameItem(x, { name: r.name, stamp: summary.stamp }));
      if (waiting) return { ...r, s3: waiting.attempts ? `retrying (${waiting.error || 'failed'})` : 'queued' };
      return r;
    })
  };
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
    // Verified: every volume's archive was checked against the volume
    // (lib/volumeCensus.js) and the counts are in agent.json.
    let verified = false;
    try { verified = Boolean(JSON.parse(fs.readFileSync(path.join(dir, n, 'agent.json'), 'utf8')).verifiedAt); } catch (_) {}
    return { stamp: n, bytes, files, verified };
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
    // Without these a connection the far end stops answering hangs for ever:
    // on 2026-11-20 one part of a 3 GB upload to Contabo sat on a silent
    // socket for over an hour, the night's run never finished, and every
    // guest after it went without a backup (and the panel could not upgrade,
    // since an upgrade waits for a backup). requestTimeout is idle time on the
    // socket, not the length of a request, so a slow upload is fine.
    requestHandler: { connectionTimeout: 15000, requestTimeout: 120000 },
    maxAttempts: 5,
  });
}

// Waits for an @aws-sdk/lib-storage Upload, and aborts it when no bytes have
// moved for stallMs: the socket timeout catches a dead connection, this
// catches anything else that stops progress (a part that is retried for ever,
// a response that never comes).
function doneOrStalled(upload, { stallMs = 10 * 60 * 1000, checkMs = 15000, label = 'upload', now = Date.now } = {}) {
  let last = now();
  let loaded = -1;
  upload.on('httpUploadProgress', p => {
    if (p && typeof p.loaded === 'number' && p.loaded !== loaded) { loaded = p.loaded; last = now(); }
  });
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (now() - last < stallMs) return;
      clearInterval(timer);
      upload.abort().catch(() => {});
      reject(new Error(`${label}: no progress for ${Math.round(stallMs / 60000)} min, aborted`));
    }, checkMs);
  });
  return Promise.race([upload.done(), stalled]).finally(() => clearInterval(timer));
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

// Uploads one backup folder, file by file (multipart for the large ones). A
// file the bucket already has at the same size is skipped, so an upload a
// restart cut off carries on with the file it was on; parts that upload left
// behind are aborted first, or the bucket keeps (and bills) them.
// onProgress(bytesDone, bytesTotal) follows it.
async function uploadBackup(c, agentName, backupStamp, dir, { onProgress = () => {} } = {}) {
  const { Upload } = require('@aws-sdk/lib-storage');
  const { HeadObjectCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
  const client = s3Client(c);
  const base = `${remotePrefix(c.prefix, agentName)}${backupStamp}/`;
  const files = fs.readdirSync(dir).map(f => ({ f, size: fs.statSync(path.join(dir, f)).size }));
  const total = files.reduce((n, x) => n + x.size, 0);
  try {
    const open = await client.send(new ListMultipartUploadsCommand({ Bucket: c.bucket, Prefix: base }));
    for (const u of open.Uploads || []) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: c.bucket, Key: u.Key, UploadId: u.UploadId })).catch(() => {});
    }
  } catch (_) { /* a bucket that cannot list them has none we made */ }
  let done = 0;
  let skipped = 0;
  for (const { f, size } of files) {
    const Key = `${base}${f}`;
    const have = await client.send(new HeadObjectCommand({ Bucket: c.bucket, Key })).catch(() => null);
    if (have && Number(have.ContentLength) === size) { done += size; skipped++; onProgress(done, total); continue; }
    const upload = new Upload({
      client,
      params: { Bucket: c.bucket, Key, Body: fs.createReadStream(path.join(dir, f)) },
      partSize: 16 * 1024 * 1024,
      queueSize: 2,
    });
    upload.on('httpUploadProgress', p => { if (p && typeof p.loaded === 'number') onProgress(done + p.loaded, total); });
    await doneOrStalled(upload, { label: f });
    done += size;
    onProgress(done, total);
  }
  return { bytes: total, skipped };
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
  stamp, isDue, beyondKeep, readSettings, remotePrefix, listLocal, resumable, localToRemove, RESUME_WITHIN_MS,
  testS3, uploadBackup, listRemote, pruneRemote, doneOrStalled,
  UPLOAD_ATTEMPTS, UPLOAD_RETRY_MS, parseQueue, queueAdd, queueRemove, nextUpload, afterFailure, queuedStamps, recordUpload, withUploads,
};
