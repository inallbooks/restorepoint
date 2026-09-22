const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('../lib/engine');
const { snapshotDir } = require('../lib/store');

(async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'snaprebuild-'));
  fs.writeFileSync(path.join(proj, 'a.js'), 'aaa');
  fs.writeFileSync(path.join(proj, 'b.js'), 'bbb');

  const s1 = await engine.createSnapshot(proj, 'first');
  await new Promise(r => setTimeout(r, 1100));
  const s2 = await engine.createSnapshot(proj, 'second');

  // corrupt the index — the situation the self-heal fixes
  const idx = path.join(snapshotDir(proj, (await engine.getState(proj)).settings), 'index.json');
  fs.writeFileSync(idx, '{ broken json !!!');

  const st = await engine.getState(proj); // must self-heal, not crash
  if (st.snapshots.length !== 2) throw new Error('rebuild failed: got ' + st.snapshots.length + ' snapshots');
  if (!st.snapshots.some(s => s.name === 'first') || !st.snapshots.some(s => s.name === 'second')) {
    throw new Error('rebuild lost names: ' + st.snapshots.map(s => s.name).join(','));
  }

  // diff: modify a file, remove one, add one
  const d = await engine.diffSnapshots(proj, s1.id, s2.id);
  if (d.added.length || d.removed.length || d.changed.length) throw new Error('identical snapshots show diff: ' + JSON.stringify(d));
  fs.writeFileSync(path.join(proj, 'a.js'), 'CHANGED');
  fs.unlinkSync(path.join(proj, 'b.js'));
  fs.writeFileSync(path.join(proj, 'c.js'), 'new');
  const s3 = await engine.createSnapshot(proj, 'third');
  const d2 = await engine.diffSnapshots(proj, s2.id, s3.id);
  if (d2.changed.length !== 1 || !d2.changed[0].includes('a.js')) throw new Error('diff changed wrong: ' + JSON.stringify(d2.changed));
  if (d2.removed.length !== 1 || !d2.removed[0].includes('b.js')) throw new Error('diff removed wrong: ' + JSON.stringify(d2.removed));
  if (d2.added.length !== 1 || !d2.added[0].includes('c.js')) throw new Error('diff added wrong: ' + JSON.stringify(d2.added));

  console.log('REBUILD + DIFF TEST PASSED — corrupt index self-healed, diff accurate');
  fs.rmSync(proj, { recursive: true, force: true });
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
