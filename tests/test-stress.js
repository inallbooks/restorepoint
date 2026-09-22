const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('../lib/engine');

function makeTree(proj) {
  // many files, deep nesting, unicode, spaces — stress the walker and zip
  for (let i = 0; i < 300; i++) {
    const sub = path.join(proj, 'src', 'deep' + (i % 7), 'mod ' + i, 'uni\u00e9\u4e2d');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `f${i}.js`), 'x'.repeat(200 + i));
  }
  fs.mkdirSync(path.join(proj, 'empty'));
  fs.writeFileSync(path.join(proj, 'sp ace.txt'), 'hello');
  fs.writeFileSync(path.join(proj, '.gitignore'), 'empty/\n');
}

(async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'snapstress-'));
  makeTree(proj);

  process.on('unhandledRejection', e => { console.error('UNHANDLED REJECTION:', e); process.exit(2); });
  process.on('uncaughtException', e => { console.error('UNCAUGHT:', e); process.exit(3); });

  console.log('creating snapshot of', proj);
  const snap = await engine.createSnapshot(proj, 'stress');

  fs.rmSync(path.join(proj, 'src'), { recursive: true, force: true });
  fs.writeFileSync(path.join(proj, 'new-file.txt'), 'appeared after snapshot');

  console.log('restoring…');
  await engine.restoreSnapshot(proj, snap.id);

  if (!fs.existsSync(path.join(proj, 'src', 'deep0'))) throw new Error('restore incomplete');
  if (fs.existsSync(path.join(proj, 'new-file.txt'))) throw new Error('stray survived');
  console.log('STRESS TEST PASSED');
  fs.rmSync(proj, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
