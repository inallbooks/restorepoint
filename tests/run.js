const { spawnSync } = require('child_process');
const path = require('path');
const tests = ['test-engine.js', 'test-preserve.js', 'test-stress.js', 'test-rebuild.js', 'test-watch.js'];
let failed = 0;
for (const t of tests) {
  console.log(`\n=== ${t} ===`);
  const r = spawnSync('node', [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} TEST FILE(S) FAILED` : '\nALL TESTS PASSED');
process.exit(failed ? 1 : 0);
