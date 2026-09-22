const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('../lib/engine');

(async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'snaptest-'));
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'console.log("v1");\n'.repeat(500));
  fs.writeFileSync(path.join(proj, 'src', 'b.txt'), 'data'.repeat(1000));
  fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(proj, 'node_modules', 'junk', 'x.js'), 'ignored');

  const snap = await engine.createSnapshot(proj, 'first');
  console.log('SNAP OK', snap.fileCount, 'files,', snap.zipBytes, 'bytes (orig', snap.originalBytes + ')');
  if (snap.fileCount !== 3) throw new Error('ignore failed: expected 3 files, got ' + snap.fileCount);

  fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'console.log("v2 CHANGED");\n');
  fs.writeFileSync(path.join(proj, 'stray.txt'), 'should vanish after restore');

  await engine.restoreSnapshot(proj, snap.id);
  const a = fs.readFileSync(path.join(proj, 'src', 'a.js'), 'utf8');
  if (!a.includes('v1')) throw new Error('restore failed: content is v2');
  if (fs.existsSync(path.join(proj, 'stray.txt'))) throw new Error('restore failed: stray file survived');
  if (!fs.existsSync(path.join(proj, '.snapshot'))) throw new Error('backup dir was wiped!');

  const st = await engine.getState(proj);
  console.log('RESTORE OK — v1 back, stray removed, .snapshot intact');
  console.log('Snapshots now:', st.snapshots.length, '(1 manual + 1 auto safety)');
  console.log('ALL TESTS PASSED');
  fs.rmSync(proj, { recursive: true, force: true });
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
