const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('../lib/engine');

(async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'snappreserve-'));
  fs.mkdirSync(path.join(proj, 'node_modules', 'left'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'node_modules', 'left', 'x.js'), 'keep me');
  fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(proj, 'app.js'), 'v1');
  fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules/\n.env\n');

  const snap = await engine.createSnapshot(proj, 'base');
  if (snap.fileCount !== 2) throw new Error('expected 2 files (app.js + .gitignore), got ' + snap.fileCount);

  fs.writeFileSync(path.join(proj, 'app.js'), 'v2');
  fs.writeFileSync(path.join(proj, 'stray.txt'), 'gone soon');

  await engine.restoreSnapshot(proj, snap.id);

  if (fs.readFileSync(path.join(proj, 'app.js'), 'utf8') !== 'v1') throw new Error('app.js not restored');
  if (fs.existsSync(path.join(proj, 'stray.txt'))) throw new Error('stray survived');
  if (!fs.existsSync(path.join(proj, 'node_modules', 'left', 'x.js'))) throw new Error('node_modules was deleted!');
  if (!fs.existsSync(path.join(proj, '.env'))) throw new Error('.env was deleted!');

  // also verify preserve OFF deletes them
  const { loadSettings, saveSettings } = require('../lib/store');
  const s = await loadSettings(proj);
  s.preserveIgnoredOnRestore = false;
  await saveSettings(proj, s);
  await engine.restoreSnapshot(proj, snap.id);
  if (fs.existsSync(path.join(proj, 'node_modules'))) throw new Error('preserve-off failed: node_modules survived');
  if (fs.existsSync(path.join(proj, '.env'))) throw new Error('preserve-off failed: .env survived');

  console.log('PRESERVE TEST PASSED — ignored paths survive when ON, deleted when OFF');
  fs.rmSync(proj, { recursive: true, force: true });
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
