const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SNAP_DIR_NAME = '.snapshot';

function defaultSettings() {
  return {
    backupPath: '',            // '' => <project>/.snapshot
    respectGitignore: true,
    manualIgnores: [],         // [{ id, type: 'file'|'folder'|'glob', value }]
    preserveIgnoredOnRestore: true,
    autoSnapshotHours: 0,      // 0 = off; N = auto-snapshot every N hours
    watchEnabled: true,        // live change detection
    autoSnapshotBeforeAgent: false, // snapshot when an AI agent session starts
    autoSnapAfterSession: false     // snapshot when a change session ends (5 min idle)
  };
}

function snapshotDir(projectRoot, settings) {
  return settings.backupPath && settings.backupPath.trim()
    ? path.resolve(settings.backupPath.trim())
    : path.join(projectRoot, SNAP_DIR_NAME);
}

function settingsFile(projectRoot) {
  return path.join(projectRoot, SNAP_DIR_NAME, 'settings.json');
}

async function loadSettings(projectRoot) {
  try {
    const raw = await fsp.readFile(settingsFile(projectRoot), 'utf8');
    return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    return defaultSettings();
  }
}

async function saveSettings(projectRoot, settings) {
  const dir = path.join(projectRoot, SNAP_DIR_NAME);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = settingsFile(projectRoot) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(settings, null, 2));
  await fsp.rename(tmp, settingsFile(projectRoot));
}

async function loadIndex(backupDir) {
  let raw;
  try { raw = await fsp.readFile(path.join(backupDir, 'index.json'), 'utf8'); }
  catch { return { snapshots: [] }; }             // no index yet — fine
  try { return JSON.parse(raw); }
  catch (e) { const err = new Error('Corrupt index.json'); err.corrupt = true; throw err; }
}

async function saveIndex(backupDir, index) {
  await fsp.mkdir(backupDir, { recursive: true });
  const tmp = path.join(backupDir, 'index.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify(index, null, 2));
  await fsp.rename(tmp, path.join(backupDir, 'index.json'));
}

module.exports = { defaultSettings, snapshotDir, loadSettings, saveSettings, loadIndex, saveIndex, SNAP_DIR_NAME };
