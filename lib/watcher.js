const fs = require('fs');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const engine = require('./engine');
const { snapshotDir } = require('./store');

let watcher = null;
let timer = null;
let projectRoot = null;
let settings = null;
let ig = null;

const dirty = new Map();       // relPath -> 'add' | 'change' | 'unlink'
let sessionActive = false;
let sessionStart = 0;
let sessionAgent = false;
let lastActivity = 0;
let quietMs = 5 * 60 * 1000;
let lastBroadcast = 0;

function agentTouch(root) {
  // heuristic: recent mtime on known agent state folders = an AI agent is working
  const dirs = [
    path.join(root, '.kilo'), path.join(root, '.claude'),
    path.join(root, '.cursor'), path.join(root, '.codex'),
    path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.kilo'),
    path.join(os.homedir(), '.cursor'), path.join(os.homedir(), '.codex')
  ];
  const now = Date.now();
  for (const d of dirs) {
    try { if (now - fs.statSync(d).mtimeMs < 90000) return true; } catch { }
  }
  return false;
}

function markDirty(rel, type) {
  if (!projectRoot || !settings || !settings.watchEnabled) return;
  if (engine.isBusy()) return; // our own snapshot/restore writes — not user changes
  dirty.set(rel, type);
  lastActivity = Date.now();
  if (!sessionActive) {
    sessionActive = true;
    sessionStart = lastActivity;
    sessionAgent = agentTouch(projectRoot);
    if (settings.autoSnapshotBeforeAgent && sessionAgent) {
      engine.createSnapshot(projectRoot, 'Auto — before agent session', { auto: true })
        .then(() => engine.pruneAuto(projectRoot)).catch(() => { });
    }
  } else if (!sessionAgent) {
    sessionAgent = agentTouch(projectRoot);
  }
  const now = Date.now();
  if (now - lastBroadcast > 1000) {
    lastBroadcast = now;
    engine.broadcast({ type: 'dirty', count: dirty.size });
  }
}

function checkSessionEnd() {
  if (!sessionActive || !projectRoot || !settings) return;
  if (Date.now() - lastActivity < quietMs) return;
  const changes = dirty.size;
  const wasAgent = sessionAgent;
  sessionActive = false;
  if (settings.autoSnapAfterSession && changes > 0 && !engine.isBusy()) {
    engine.createSnapshot(projectRoot,
      `Auto — session end (${changes} change${changes === 1 ? '' : 's'}${wasAgent ? ', AI' : ''})`,
      { auto: true })
      .then(() => engine.pruneAuto(projectRoot)).catch(() => { });
  }
}

async function stop() {
  if (watcher) { try { await watcher.close(); } catch { } watcher = null; }
  if (timer) { clearInterval(timer); timer = null; }
  dirty.clear();
  sessionActive = false;
}

async function setProject(root, st, opts = {}) {
  await stop();
  projectRoot = root;
  settings = st || {};
  quietMs = opts.quietMs || 5 * 60 * 1000;
  if (!root || !settings.watchEnabled) return;

  const backupDir = snapshotDir(root, settings);
  ig = engine.buildIgnore(root, settings, backupDir);

  watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: rawAbs => {
      if (!rawAbs) return false;
      const abs = path.resolve(rawAbs); // normalize chokidar's forward slashes
      if (abs === root) return false;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..')) return true;
      if (abs === backupDir || abs === path.join(root, '.snapshot')) return true;
      try { return ig.ignores(rel) || ig.ignores(rel + '/'); } catch { return false; }
    }
  });
  watcher.on('add', f => markDirty(path.relative(root, f).replace(/\\/g, '/'), 'add'));
  watcher.on('change', f => markDirty(path.relative(root, f).replace(/\\/g, '/'), 'change'));
  watcher.on('unlink', f => markDirty(path.relative(root, f).replace(/\\/g, '/'), 'unlink'));
  timer = setInterval(checkSessionEnd, 15000);
  timer.unref();
}

// engine notifies after each completed snapshot/restore: baseline is fresh again
engine.setOpDone(() => {
  dirty.clear();
  sessionActive = false;
});

function getDirty() {
  return {
    watching: !!(watcher && settings && settings.watchEnabled),
    count: dirty.size,
    files: [...dirty.entries()].map(([p, t]) => ({ path: p, type: t })),
    session: { active: sessionActive, startedAt: sessionActive ? sessionStart : null, agent: sessionAgent }
  };
}

module.exports = { setProject, stop, getDirty };
