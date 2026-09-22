require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', err => {
  const line = `[${new Date().toISOString()}] UNCAUGHT: ${err && err.stack || err}\n`;
  try { fs.appendFileSync(path.join(__dirname, 'crash.log'), line); } catch { }
  console.error(line);
});
process.on('unhandledRejection', err => {
  const line = `[${new Date().toISOString()}] UNHANDLED REJECTION: ${err && err.stack || err}\n`;
  try { fs.appendFileSync(path.join(__dirname, 'crash.log'), line); } catch { }
  console.error(line);
});
const fsp = fs.promises;
const engine = require('./lib/engine');
const watcher = require('./lib/watcher');
const { loadSettings, saveSettings, snapshotDir } = require('./lib/store');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let projectRoot = null;

/* persisted last project (survives restart) */
const CONFIG_FILE = path.join(__dirname, 'config.json');
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ lastProject: projectRoot }, null, 2)); } catch { }
}
(function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c.lastProject && fs.statSync(c.lastProject).isDirectory()) {
      projectRoot = path.resolve(c.lastProject);
      loadSettings(projectRoot).then(s => watcher.setProject(projectRoot, s)).catch(() => { });
    }
  } catch { /* no config or stale path */ }
})();

/* block cross-origin API calls: a malicious website open in the browser
   must not be able to POST to localhost and mutate/restore/delete */
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return res.status(403).json({ error: 'Cross-origin request blocked' });
      }
    } catch { return res.status(403).json({ error: 'Bad origin' }); }
  }
  next();
});

function requireProject(req, res, next) {
  if (!projectRoot) return res.status(400).json({ error: 'No project open' });
  next();
}

app.get('/api/state', async (req, res) => {
  if (!projectRoot) return res.json({ projectRoot: null });
  try { res.json(await engine.getState(projectRoot)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

async function ensureSnapIgnore(projectRoot) {
  const gi = path.join(projectRoot, '.gitignore');
  let content = '';
  try { content = fs.readFileSync(gi, 'utf8'); } catch { }
  if (/^\/?\.snapshot\/?\s*$/m.test(content)) return;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gi, content + prefix + '\n# snapshot app backups\n.snapshot/\n');
}

app.post('/api/project', async (req, res) => {
  const p = String(req.body.path || '').trim();
  if (!p) return res.status(400).json({ error: 'Path required' });
  try {
    const st = await fsp.stat(p);
    if (!st.isDirectory()) throw new Error('Not a folder');
    projectRoot = path.resolve(p);
    try { await ensureSnapIgnore(projectRoot); } catch { /* non-fatal */ }
    saveConfig();
    try { watcher.setProject(projectRoot, await loadSettings(projectRoot)); } catch { }
    res.json({ ok: true, projectRoot });
  } catch {
    res.status(400).json({ error: 'Folder not found: ' + p });
  }
});

function listDrives() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const drive = letter + ':\\';
    try {
      fs.statSync(drive);
      drives.push(drive);
    } catch { /* drive not present */ }
  }
  return drives;
}

app.get('/api/fs', async (req, res) => {
  const p = String(req.query.path || '').trim();
  // root view: list all available drives
  if (!p) {
    return res.json({ path: '', isRoot: true, parent: null, dirs: listDrives() });
  }
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let ok = true;
      try { await fsp.access(path.join(p, e.name)); } catch { ok = false; }
      if (ok) dirs.push(e.name);
    }
    const parent = path.dirname(p) !== p ? path.dirname(p) : null;
    res.json({ path: p, isRoot: false, parent, dirs });
  } catch {
    res.status(400).json({ error: 'Cannot read: ' + p });
  }
});

app.put('/api/settings', requireProject, async (req, res) => {
  try {
    const current = await loadSettings(projectRoot);
    const next = { ...current, ...req.body };
    next.manualIgnores = Array.isArray(next.manualIgnores) ? next.manualIgnores : [];
    await saveSettings(projectRoot, next);
    try { watcher.setProject(projectRoot, next); } catch { }
    res.json(await engine.getState(projectRoot));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dirty', requireProject, (req, res) => {
  try { res.json(watcher.getDirty()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/snapshots', requireProject, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim() || 'Snapshot';
    const snap = await engine.createSnapshot(projectRoot, name);
    res.json(snap);
  } catch (e) { res.status(engine.isBusy() ? 409 : 500).json({ error: e.message }); }
});

app.post('/api/snapshots/:id/restore', requireProject, async (req, res) => {
  try {
    await engine.restoreSnapshot(projectRoot, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/snapshots/:id', requireProject, async (req, res) => {
  try {
    await engine.deleteSnapshot(projectRoot, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/snapshots/:id', requireProject, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    await engine.renameSnapshot(projectRoot, req.params.id, name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/snapshots/:a/diff/:b', requireProject, async (req, res) => {
  try {
    res.json(await engine.diffSnapshots(projectRoot, req.params.a, req.params.b));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  engine.bus.listeners.add(res);
  req.on('close', () => engine.bus.listeners.delete(res));
});

/* scheduled auto-snapshots (setting: autoSnapshotHours, 0 = off) */
setInterval(async () => {
  if (!projectRoot || engine.isBusy()) return;
  try {
    const st = await engine.getState(projectRoot);
    const hrs = Number(st.settings.autoSnapshotHours) || 0;
    if (!hrs) return;
    const latest = st.snapshots[0];
    const ageH = latest ? (Date.now() - new Date(latest.date)) / 36e5 : Infinity;
    if (ageH >= hrs) {
      await engine.createSnapshot(projectRoot, 'Auto — scheduled', { auto: true });
      await engine.pruneAuto(projectRoot);
    }
  } catch { /* never crash the timer */ }
}, 5 * 60 * 1000).unref();

const PORT = Number(process.env.PORT) || 3777;
const server = app.listen(PORT);
server.on('error', () => { app.listen(PORT + 1, () => console.log(`Snapshot app on http://localhost:${PORT + 1}`)); });
server.on('listening', () => console.log(`Snapshot app on http://localhost:${PORT}`));
