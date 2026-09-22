const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('../lib/engine');
const watcher = require('../lib/watcher');
const { loadSettings } = require('../lib/store');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'snapwatch-'));
  fs.writeFileSync(path.join(proj, 'app.js'), 'v0');
  fs.writeFileSync(path.join(proj, '.gitignore'), 'ignored-dir/\n');
  fs.mkdirSync(path.join(proj, 'ignored-dir'), { recursive: true });

  const settings = await loadSettings(proj);
  settings.watchEnabled = true;
  await watcher.setProject(proj, settings);
  await sleep(2500); // let chokidar settle

  // 1. change a tracked file -> dirty
  fs.writeFileSync(path.join(proj, 'app.js'), 'v1');
  await sleep(1500);
  let d = watcher.getDirty();
  if (!d.watching) throw new Error('watcher not running');
  if (d.count !== 1 || !d.files[0].path.includes('app.js')) throw new Error('dirty tracking failed: ' + JSON.stringify(d.files));
  if (!d.session.active) throw new Error('session should be active');
  console.log('OK: change detected, session active');

  // 2. ignored dir changes -> not tracked
  fs.writeFileSync(path.join(proj, 'ignored-dir', 'x.txt'), 'nope');
  await sleep(1500);
  d = watcher.getDirty();
  if (d.count !== 1) throw new Error('ignore filter leaked: ' + JSON.stringify(d.files));
  console.log('OK: ignored dir not tracked');

  // 3. .snapshot writes -> not tracked
  fs.mkdirSync(path.join(proj, '.snapshot'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.snapshot', 'noise.txt'), 'nope');
  await sleep(1500);
  d = watcher.getDirty();
  if (d.count !== 1) throw new Error('.snapshot leaked into dirty: ' + JSON.stringify(d.files));
  console.log('OK: .snapshot folder not tracked');

  // 4. snapshot clears dirty
  await engine.createSnapshot(proj, 'clears-dirty');
  await sleep(300);
  d = watcher.getDirty();
  if (d.count !== 0) throw new Error('dirty not cleared after snapshot');
  console.log('OK: dirty cleared after snapshot');

  // 5. new file after snapshot -> dirty again
  fs.writeFileSync(path.join(proj, 'new.txt'), 'x');
  await sleep(1500);
  d = watcher.getDirty();
  if (d.count !== 1 || d.files[0].type !== 'add') throw new Error('new file not detected: ' + JSON.stringify(d.files));
  console.log('OK: new file detected after snapshot');

  // 6. watcher disabled in settings -> stops tracking
  await watcher.setProject(proj, { ...settings, watchEnabled: false });
  await sleep(400);
  fs.writeFileSync(path.join(proj, 'another.txt'), 'x');
  await sleep(1500);
  d = watcher.getDirty();
  if (d.watching || d.count !== 0) throw new Error('disable failed');
  console.log('OK: watcher honors watchEnabled=false');

  console.log('WATCHER TEST PASSED');
  await watcher.stop();
  fs.rmSync(proj, { recursive: true, force: true });
  process.exit(0);
})().catch(async e => {
  console.error('FAIL:', e.message);
  await watcher.stop();
  process.exit(1);
});
