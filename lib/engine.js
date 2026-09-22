const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const ignorePkg = require('ignore');
const { snapshotDir, loadSettings, loadIndex, saveIndex, SNAP_DIR_NAME } = require('./store');

const bus = { listeners: new Set() };
function emit(data) {
  const msg = JSON.stringify(data);
  for (const res of bus.listeners) res.write(`data: ${msg}\n\n`);
}
let opDone = null; // notified after every completed snapshot/restore
function setOpDone(fn) { opDone = fn; }
function notifyOpDone() { try { if (opDone) opDone(); } catch { } }

let busy = false;

function slug(name) {
  return (name || 'snapshot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snapshot';
}

function buildIgnore(projectRoot, settings, backupDir) {
  const ig = ignorePkg();
  if (settings.respectGitignore) {
    try {
      const gi = path.join(projectRoot, '.gitignore');
      if (fs.existsSync(gi)) ig.add(fs.readFileSync(gi, 'utf8'));
    } catch { /* unreadable gitignore — skip */ }
  }
  for (const item of settings.manualIgnores || []) {
    const v = String(item.value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!v) continue;
    if (item.type === 'folder') { ig.add(v); ig.add(v + '/**'); }
    else if (item.type === 'glob') { ig.add(v); }
    else { ig.add(v); }
  }
  ig.add(SNAP_DIR_NAME); ig.add(SNAP_DIR_NAME + '/**');
  ig.ignoredDirs = new Set([path.resolve(backupDir), path.resolve(projectRoot, SNAP_DIR_NAME)]);
  return ig;
}

async function walk(projectRoot, ig, onProgress) {
  const files = [];
  let totalBytes = 0, skipped = 0, lastEmit = 0;
  const stack = [projectRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { skipped++; continue; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (ig.ignoredDirs.has(abs)) continue;
      const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        try { if (!ig.ignores(rel) && !ig.ignores(rel + '/')) stack.push(abs); }
        catch { /* invalid pattern */ }
      } else if (e.isFile()) {
        try { if (ig.ignores(rel)) continue; } catch { /* invalid pattern */ }
        let st;
        try { st = await fsp.stat(abs); } catch { skipped++; continue; }
        files.push({ rel, abs, size: st.size });
        totalBytes += st.size;
        const now = Date.now();
        if (onProgress && now - lastEmit > 120) {
          lastEmit = now;
          onProgress(files.length, totalBytes);
        }
      }
    }
  }
  return { files, totalBytes, skipped };
}

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function createSnapshot(projectRoot, name, { auto = false } = {}) {
  if (busy) throw new Error('Another operation is running');
  busy = true;
  const started = Date.now();
  try {
    const settings = await loadSettings(projectRoot);
    const backupDir = snapshotDir(projectRoot, settings);
    const archiveDir = path.join(backupDir, 'snapshots');
    await fsp.mkdir(archiveDir, { recursive: true });
    const ig = buildIgnore(projectRoot, settings, backupDir);

    emit({ type: 'progress', op: 'snapshot', phase: 'scan', pct: 0, message: 'Scanning codebase…' });
    const { files, totalBytes, skipped } = await walk(projectRoot, ig,
      (n, b) => emit({ type: 'progress', op: 'snapshot', phase: 'scan', pct: 0, message: `Scanning… ${n} files`, files: n, bytes: b }));

    if (!files.length) throw new Error('Nothing to snapshot — everything is ignored or the folder is empty.');

    // disk space guard (Node >= 18.15)
    try {
      const stfs = fs.statfsSync(archiveDir);
      const free = stfs.bavail * Number(stfs.bsize);
      if (free < totalBytes) throw new Error(`Not enough disk space: need ~${(totalBytes / 1048576).toFixed(1)} MB, only ${(free / 1048576).toFixed(1)} MB free`);
    } catch (e) { if (String(e.message).includes('disk space')) throw e; }

    const id = `${Date.now()}-${slug(name)}`;
    const zipPath = path.join(archiveDir, `${fmtDate(new Date())}-${id}.zip`);
    const meta = { name, auto, date: new Date().toISOString(), fileCount: files.length, totalBytes, generatedBy: 'snapshot-app' };

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const zip = archiver('zip', { zlib: { level: 1 } });
      out.on('close', resolve);
      zip.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });
      zip.on('error', reject);
      zip.pipe(out);

      zip.append(Buffer.from(JSON.stringify(meta, null, 2)), { name: '__snapshot_meta.json' });
      let done = 0, lastEmit = 0;
      for (const f of files) {
        try { zip.file(f.abs, { name: f.rel, stats: { size: f.size } }); } catch { /* skip unreadable */ }
        done += f.size;
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          emit({ type: 'progress', op: 'snapshot', phase: 'zip', pct: Math.min(99, Math.round((done / Math.max(totalBytes, 1)) * 100)), message: 'Compressing…', files: files.length });
        }
      }
      emit({ type: 'progress', op: 'snapshot', phase: 'finalize', pct: 99, message: 'Finalizing archive…' });
      zip.finalize();
    });

    const st = await fsp.stat(zipPath);
    const index = await loadIndex(backupDir);
    index.snapshots.push({
      id, name: name || 'Snapshot', auto,
      date: meta.date,
      fileCount: files.length,
      originalBytes: totalBytes,
      zipBytes: st.size,
      zip: path.basename(zipPath),
      skipped,
      durationMs: Date.now() - started
    });
    await saveIndex(backupDir, index);
    emit({ type: 'progress', op: 'snapshot', phase: 'done', pct: 100, message: 'Snapshot saved' });
    emit({ type: 'refresh' });
    return index.snapshots[index.snapshots.length - 1];
  } finally { busy = false; notifyOpDone(); }
}

async function pruneAuto(projectRoot, keep = 8) {
  const settings = await loadSettings(projectRoot);
  const backupDir = snapshotDir(projectRoot, settings);
  const index = await loadIndex(backupDir);
  const autos = index.snapshots.filter(s => s.auto);
  if (autos.length > keep) {
    const doomed = new Set(autos.slice(0, autos.length - keep).map(s => s.id));
    for (const s of index.snapshots.filter(s => doomed.has(s.id))) {
      try { await fsp.rm(path.join(backupDir, 'snapshots', s.zip), { force: true }); } catch { }
    }
    index.snapshots = index.snapshots.filter(s => !doomed.has(s.id));
    await saveIndex(backupDir, index);
  }
}

async function withRetry(fn, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; await new Promise(r => setTimeout(r, 300 * (i + 1))); }
  }
  throw err;
}

async function cleanProject(root, ig, keepDirs) {
  // remove every file/dir not matching ignore rules; preserved paths survive
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(root, e.name);
    if (keepDirs.has(abs)) continue;
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    let ignored = false;
    try { ignored = ig.ignores(rel) || ig.ignores(rel + '/'); } catch { }
    if (ignored) continue;
    if (e.isDirectory()) {
      await cleanProject(abs, ig, keepDirs);
      try { await fsp.rmdir(abs); } catch { /* not empty (holds preserved files) */ }
    } else {
      await withRetry(() => fsp.rm(abs, { force: true }));
    }
  }
}

async function restoreSnapshot(projectRoot, snapshotId) {
  if (busy) throw new Error('Another operation is running');
  busy = true;
  try {
    const settings = await loadSettings(projectRoot);
    const backupDir = snapshotDir(projectRoot, settings);
    const ig = buildIgnore(projectRoot, settings, backupDir);
    const index = await loadIndex(backupDir);
    const snap = index.snapshots.find(s => s.id === snapshotId);
    if (!snap) throw new Error('Snapshot not found');
    const zipPath = path.join(backupDir, 'snapshots', snap.zip);

    busy = false;
    emit({ type: 'progress', op: 'restore', phase: 'safety', pct: 0, message: 'Saving safety snapshot of current code…' });
    const stamp = new Date().toLocaleTimeString();
    await createSnapshot(projectRoot, `Auto — before restore ${stamp}`, { auto: true });
    await pruneAuto(projectRoot);
    busy = true;

    const tmpDir = path.join(backupDir, '_restore_tmp');
    await withRetry(() => fsp.rm(tmpDir, { recursive: true, force: true }));
    await fsp.mkdir(tmpDir, { recursive: true });

    // read central directory for exact totals
    const cd = await unzipper.Open.file(zipPath);
    const entriesAll = cd.files.filter(f => f.type === 'File');

    emit({ type: 'progress', op: 'restore', phase: 'extract', pct: 0, message: 'Extracting snapshot…', files: entriesAll.length });
    await new Promise((resolve, reject) => {
      let doneCount = 0, lastEmit = 0;
      const totalEntries = entriesAll.length;
      const bump = () => {
        doneCount++;
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          const pct = Math.min(95, Math.round((doneCount / Math.max(totalEntries, 1)) * 95));
          emit({ type: 'progress', op: 'restore', phase: 'extract', pct, message: 'Extracting…' });
        }
      };
      const pipes = [];
      fs.createReadStream(zipPath).pipe(unzipper.Parse())
        .on('entry', entry => {
          if (entry.path === '__snapshot_meta.json' || entry.type === 'Directory') { entry.autodrain(); return; }
          const dest = path.resolve(tmpDir, entry.path);
          if (!dest.startsWith(tmpDir + path.sep)) { entry.autodrain(); return; } // zip-slip guard
          pipes.push((async () => {
            await fsp.mkdir(path.dirname(dest), { recursive: true }).catch(() => { });
            await new Promise(res => {
              const ws = fs.createWriteStream(dest, { flags: 'wx' });
              ws.on('error', () => { bump(); res(); });
              ws.on('close', () => { bump(); res(); });
              entry.on('error', () => { try { ws.destroy(); } catch { } bump(); res(); });
              entry.pipe(ws);
            });
          })());
        })
        .on('error', reject)
        .on('finish', () => Promise.all(pipes).then(resolve).catch(reject));
    });

    emit({ type: 'progress', op: 'restore', phase: 'swap', pct: 96, message: 'Replacing current code…' });
    const keepDirs = new Set([path.resolve(backupDir), path.resolve(projectRoot, SNAP_DIR_NAME)]);
    if (settings.preserveIgnoredOnRestore) {
      await cleanProject(projectRoot, ig, keepDirs);
    } else {
      const children = await fsp.readdir(projectRoot, { withFileTypes: true });
      for (const c of children) {
        const abs = path.join(projectRoot, c.name);
        if (keepDirs.has(abs)) continue;
        await withRetry(() => fsp.rm(abs, { recursive: true, force: true }));
      }
    }
    const tmpChildren = await fsp.readdir(tmpDir);
    for (const name of tmpChildren) {
      const dest = path.join(projectRoot, name);
      await withRetry(() => fsp.rm(dest, { recursive: true, force: true })); // snapshot content wins over preserved leftovers
      await withRetry(() => fsp.rename(path.join(tmpDir, name), dest));
    }
    await withRetry(() => fsp.rm(tmpDir, { recursive: true, force: true }));

    emit({ type: 'progress', op: 'restore', phase: 'done', pct: 100, message: 'Restore complete' });
    emit({ type: 'refresh' });
  } finally { busy = false; notifyOpDone(); }
}

async function deleteSnapshot(projectRoot, snapshotId) {  const settings = await loadSettings(projectRoot);
  const backupDir = snapshotDir(projectRoot, settings);
  const index = await loadIndex(backupDir);
  const snap = index.snapshots.find(s => s.id === snapshotId);
  if (!snap) throw new Error('Snapshot not found');
  await fsp.rm(path.join(backupDir, 'snapshots', snap.zip), { force: true });
  index.snapshots = index.snapshots.filter(s => s.id !== snapshotId);
  await saveIndex(backupDir, index);
  emit({ type: 'refresh' });
}

async function renameSnapshot(projectRoot, snapshotId, name) {
  const settings = await loadSettings(projectRoot);
  const backupDir = snapshotDir(projectRoot, settings);
  const index = await loadIndex(backupDir);
  const snap = index.snapshots.find(s => s.id === snapshotId);
  if (!snap) throw new Error('Snapshot not found');
  snap.name = name;
  await saveIndex(backupDir, index);
  emit({ type: 'refresh' });
}

/* self-heal: rebuild index.json from the zips themselves (meta embedded in each) */
async function rebuildIndex(backupDir) {
  const snapsDir = path.join(backupDir, 'snapshots');
  let zips = [];
  try { zips = await fsp.readdir(snapsDir); } catch { return { snapshots: [] }; }
  const snaps = [];
  for (const z of zips.filter(n => n.endsWith('.zip'))) {
    try {
      const abs = path.join(snapsDir, z);
      const cd = await unzipper.Open.file(abs);
      let meta = {};
      const metaEntry = cd.files.find(f => f.path === '__snapshot_meta.json');
      if (metaEntry) { try { meta = JSON.parse((await metaEntry.buffer()).toString('utf8')); } catch { } }
      const st = await fsp.stat(abs);
      const m = z.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d+)-(.*)\.zip$/);
      snaps.push({
        id: m ? m[7] + '-' + m[8] : z,
        name: meta.name || z,
        auto: !!meta.auto,
        date: meta.date || (m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : st.mtime.toISOString()),
        fileCount: meta.fileCount || cd.files.filter(f => f.type === 'File' && f.path !== '__snapshot_meta.json').length,
        originalBytes: meta.totalBytes || 0,
        zipBytes: st.size,
        zip: z,
        skipped: meta.skipped || 0,
        durationMs: 0
      });
    } catch { /* unreadable zip — skip */ }
  }
  const index = { snapshots: snaps };
  try { await saveIndex(backupDir, index); } catch { }
  return index;
}

async function loadIndexSafe(backupDir) {
  try { return await loadIndex(backupDir); }
  catch (e) { if (e.corrupt) return rebuildIndex(backupDir); throw e; }
}

async function diffSnapshots(projectRoot, idA, idB) {
  const settings = await loadSettings(projectRoot);
  const backupDir = snapshotDir(projectRoot, settings);
  const index = await loadIndexSafe(backupDir);
  const byId = {};
  for (const s of index.snapshots) byId[s.id] = s;
  const a = byId[idA], b = byId[idB];
  if (!a || !b) throw new Error('Snapshot not found');
  async function entryMap(zip) {
    const cd = await unzipper.Open.file(path.join(backupDir, 'snapshots', zip));
    const map = new Map();
    for (const f of cd.files) {
      if (f.type !== 'File' || f.path === '__snapshot_meta.json') continue;
      map.set(f.path, f.uncompressedSize || 0);
    }
    return map;
  }
  const [ma, mb] = await Promise.all([entryMap(a.zip), entryMap(b.zip)]);
  const added = [], removed = [], changed = [];
  for (const [p, size] of mb) {
    if (!ma.has(p)) added.push(p);
    else if (ma.get(p) !== size) changed.push(p);
  }
  for (const p of ma.keys()) if (!mb.has(p)) removed.push(p);
  return { a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, added, removed, changed };
}

async function getState(projectRoot) {
  const settings = await loadSettings(projectRoot);
  const backupDir = snapshotDir(projectRoot, settings);
  const index = await loadIndexSafe(backupDir);
  return {
    projectRoot,
    backupDir,
    settings,
    busy,
    snapshots: index.snapshots.slice().sort((a, b) => new Date(b.date) - new Date(a.date))
  };
}

module.exports = {
  createSnapshot, restoreSnapshot, deleteSnapshot, getState, bus,
  renameSnapshot, diffSnapshots, rebuildIndex, pruneAuto, isBusy: () => busy,
  buildIgnore, broadcast: emit, setOpDone
};
