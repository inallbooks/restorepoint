'use strict';

const $ = id => document.getElementById(id);

let state = null;
let ignoreRows = [];
let pendingRestoreId = null;
let opActive = false;

/* ---------- helpers ---------- */

function fmtBytes(b) {
  if (!b && b !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 ? b : b.toFixed(1)) + ' ' + u[i];
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 420); }, 4200);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------- render ---------- */

function render() {
  if (!state || !state.projectRoot) { $('gate').classList.remove('hidden'); $('app').classList.add('hidden'); return; }
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');

  const name = state.projectRoot.split(/[\\/]/).filter(Boolean).pop();
  $('project-name').textContent = name;
  $('project-chip').title = state.projectRoot;

  $('stat-snapshots').textContent = state.snapshots.length;
  $('stat-size').textContent = fmtBytes(state.snapshots.reduce((a, s) => a + (s.zipBytes || 0), 0));
  $('stat-path').textContent = state.backupDir;

  const tl = $('timeline');
  tl.innerHTML = '';
  $('empty').classList.toggle('hidden', state.snapshots.length > 0);

  state.snapshots.forEach((s, i) => {
    const node = document.createElement('div');
    node.className = 'tl-node' + (i === 0 ? ' latest' : '') + (s.auto ? ' auto' : '');
    node.style.animationDelay = Math.min(i * 60, 500) + 'ms';

    const del = document.hasFocus;
    node.innerHTML = `
      <div class="tl-card">
        <div class="tl-name" data-name>${esc(s.name)}${s.auto ? '<span class="tl-tag">AUTO</span>' : ''}${s.skipped ? `<span class="tl-tag warn" title="${s.skipped} files were locked/unreadable and NOT saved">⚠ ${s.skipped} skipped</span>` : ''}</div>
        <div class="tl-actions">
          <button class="btn ghost small" data-act="diff" data-id="${s.id}" title="Compare with another snapshot">Δ</button>
          <button class="btn ghost small" data-act="rename" data-id="${s.id}" title="Rename">✎</button>
          <button class="btn primary small" data-act="restore" data-id="${s.id}">Restore</button>
          <button class="btn ghost small" data-act="delete" data-id="${s.id}" title="Delete snapshot">✕</button>
        </div>
        <div class="tl-meta">
          <span>${fmtDate(s.date)}</span>
          <span>${fmtBytes(s.originalBytes)}</span>
          <span>→ ${fmtBytes(s.zipBytes)}</span>
          <span>${s.fileCount.toLocaleString()} files</span>
        </div>
      </div>`;
    if (diffSel === s.id) node.classList.add('diff-sel');
    tl.appendChild(node);
  });

  tl.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id, act = btn.dataset.act;
      const snap = state.snapshots.find(s => s.id === id);
      if (act === 'restore') openConfirm(snap);
      else if (act === 'delete') doDelete(snap);
      else if (act === 'rename') startRename(node, snap);
      else if (act === 'diff') pickDiff(snap);
    };
  });
}

let diffSel = null;

async function pickDiff(snap) {
  if (diffSel === null) {
    diffSel = snap.id;
    render();
    toast('Selected “' + snap.name + '” — now click Δ on a second snapshot to compare', '');
    return;
  }
  if (diffSel === snap.id) { diffSel = null; render(); return; }
  const a = diffSel;
  diffSel = null;
  try { showDiff(await api('GET', `/api/snapshots/${a}/diff/${snap.id}`)); }
  catch (e) { toast(e.message, 'err'); }
}

function showDiff(d) {
  const cap = (arr, cls, label) => `
    <div class="diff-sec">
      <div class="micro-label">${label} · ${arr.length}</div>
      ${arr.length ? `<div class="diff-list">${arr.slice(0, 200).map(f => `<div class="diff-file ${cls}">${esc(f)}</div>`).join('')}${arr.length > 200 ? `<div class="diff-file">… ${arr.length - 200} more</div>` : ''}</div>` : '<p class="hint">none</p>'}
    </div>`;
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal-box" style="width:min(640px,94vw);max-height:86vh;overflow-y:auto">
      <div class="micro-label">Diff</div>
      <p class="modal-text" style="font-size:14px"><strong>${esc(d.a.name)}</strong> → <strong>${esc(d.b.name)}</strong></p>
      ${cap(d.added, 'add', 'Added in second')}
      ${cap(d.removed, 'rem', 'Only in first')}
      ${cap(d.changed, 'chg', 'Changed')}
      <div class="modal-actions"><button class="btn primary" onclick="this.closest('.overlay').remove()">Close</button></div>
    </div>`;
  document.body.appendChild(ov);
}

function startRename(node, snap) {
  const nameEl = node.querySelector('[data-name]');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = snap.name;
  input.maxLength = 80;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== snap.name) {
      try { await api('PUT', '/api/snapshots/' + snap.id, { name: v }); } catch (e) { toast(e.message, 'err'); }
    }
    refresh();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  try {
    state = await api('GET', '/api/state');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- recent projects (localStorage) ---------- */

function getRecents() {
  try { return JSON.parse(localStorage.getItem('snap-recents') || '[]'); } catch { return []; }
}

function addRecent(p) {
  if (!p) return;
  const list = getRecents().filter(x => x.toLowerCase() !== p.toLowerCase());
  list.unshift(p);
  localStorage.setItem('snap-recents', JSON.stringify(list.slice(0, 5)));
  renderRecents();
}

function removeRecent(p) {
  localStorage.setItem('snap-recents', JSON.stringify(getRecents().filter(x => x !== p)));
  renderRecents();
}

function renderRecents() {
  const box = $('gate-recents');
  if (!box) return;
  const recents = getRecents();
  box.innerHTML = '';
  if (!recents.length) return;
  const label = document.createElement('div');
  label.className = 'micro-label';
  label.style.width = '100%';
  label.style.margin = '0';
  label.textContent = 'Recent projects';
  box.appendChild(label);
  recents.forEach(p => {
    const chip = document.createElement('button');
    chip.className = 'recent-chip';
    const short = p.split(/[\\/]/).filter(Boolean).pop() || p;
    chip.innerHTML = `<span>📂 ${esc(short)}</span><span class="rc-x" title="Remove">✕</span>`;
    chip.title = p;
    chip.onclick = e => {
      if (e.target.classList.contains('rc-x')) { removeRecent(p); return; }
      $('gate-path').value = p;
      $('gate-open').click();
    };
    box.appendChild(chip);
  });
}

/* ---------- gate ---------- */

$('gate-open').onclick = async () => {
  $('gate-error').textContent = '';
  try {
    const p = $('gate-path').value.trim();
    await api('POST', '/api/project', { path: p });
    addRecent(p);
    await refresh();
  } catch (e) { $('gate-error').textContent = e.message; }
};
$('gate-path').addEventListener('keydown', e => { if (e.key === 'Enter') $('gate-open').click(); });

/* folder browser (shared: gate + change project) */
$('gate-browse').onclick = () => openBrowser(p => {
  $('gate-path').value = p;
  $('gate-open').click();
});

async function openBrowser(onPick) {
  try {
    showBrowser(await api('GET', '/api/fs'), onPick);
  } catch (e) { toast(e.message, 'err'); }
}

function showBrowser(data, onPick) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  const recents = getRecents();
  const recentHtml = recents.length ? `
    <div class="micro-label" style="margin-top:6px">Recent projects</div>
    <div class="ignore-table" style="margin-bottom:12px">
      ${recents.map(p => `<button class="btn ghost small" style="text-align:left" data-recent="${esc(p)}" title="${esc(p)}">🕐 ${esc(p)}</button>`).join('')}
    </div>` : '';
  const items = data.isRoot
    ? data.dirs.map(d => `<button class="btn ghost small" style="text-align:left" data-full="${esc(d)}">💽 ${esc(d)}</button>`).join('')
    : (data.parent ? `<button class="btn ghost small" data-p="..">↑ up</button>` : '') +
      data.dirs.map(d => `<button class="btn ghost small" style="text-align:left" data-p="${esc(d)}">${esc(d)}</button>`).join('');
  ov.innerHTML = `
    <div class="modal-box" style="width:min(520px,94vw)">
      <div class="micro-label">Choose folder</div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--txt-dim);word-break:break-all;margin-bottom:14px">${data.isRoot ? 'This PC — all drives' : esc(data.path)}</div>
      ${data.isRoot ? recentHtml : ''}
      <div class="ignore-table" style="max-height:300px;overflow-y:auto">${items || '<p class="hint">No subfolders</p>'}</div>
      <div class="modal-actions">
        <button class="btn ghost" id="br-cancel">Cancel</button>
        ${data.isRoot ? '' : '<button class="btn primary" id="br-pick">Use this folder</button>'}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', async e => {
    const rec = e.target.closest('button[data-recent]');
    if (rec) {
      ov.remove();
      if (onPick) onPick(rec.dataset.recent);
      return;
    }
    const full = e.target.closest('button[data-full]');
    if (full) {
      ov.remove();
      try { showBrowser(await api('GET', '/api/fs?path=' + encodeURIComponent(full.dataset.full)), onPick); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const b = e.target.closest('button[data-p]');
    if (b) {
      const next = b.dataset.p === '..' ? data.parent : (data.path.replace(/[\\/]+$/, '') + '\\' + b.dataset.p);
      ov.remove();
      try { showBrowser(await api('GET', '/api/fs?path=' + encodeURIComponent(next)), onPick); } catch (err) { toast(err.message, 'err'); }
    }
  });
  const cancel = ov.querySelector('#br-cancel');
  if (cancel) cancel.onclick = () => ov.remove();
  const pick = ov.querySelector('#br-pick');
  if (pick) pick.onclick = () => {
    ov.remove();
    if (onPick) onPick(data.path);
  };
}

/* ---------- snapshot ---------- */

$('btn-snapshot').onclick = async () => {
  if (opActive) return;
  const name = $('snap-name').value.trim();
  $('btn-snapshot').disabled = true;
  try {
    const snap = await api('POST', '/api/snapshots', { name: name || 'Snapshot' });
    if (snap && snap.skipped) toast(`⚠ ${snap.skipped} file(s) were locked/unreadable and NOT saved in this snapshot`, 'err');
    $('snap-name').value = '';
  } catch (e) { toast(e.message, 'err'); }
  $('btn-snapshot').disabled = false;
};
$('snap-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-snapshot').click(); });

/* ---------- restore ---------- */

function openConfirm(snap) {
  pendingRestoreId = snap.id;
  $('modal-text').innerHTML = `Replace current code with <strong>“${esc(snap.name)}”</strong> (${fmtDate(snap.date)}, ${snap.fileCount.toLocaleString()} files)?`;
  const preserving = state.settings.preserveIgnoredOnRestore !== false;
  document.querySelector('.modal-note').innerHTML = preserving
    ? 'A safety snapshot of your <em>current</em> code is saved automatically first. Ignored paths (node_modules, .env…) are preserved.'
    : 'A safety snapshot of your <em>current</em> code is saved automatically first. Files not in the snapshot will be removed.';
  $('modal').classList.remove('hidden');
}
$('modal-cancel').onclick = () => { $('modal').classList.add('hidden'); pendingRestoreId = null; };
$('modal-confirm').onclick = async () => {
  $('modal').classList.add('hidden');
  if (pendingRestoreId) {
    try { await api('POST', `/api/snapshots/${pendingRestoreId}/restore`); }
    catch (e) { toast(e.message, 'err'); hideProg(); }
    pendingRestoreId = null;
  }
};

async function doDelete(snap) {
  if (!confirm(`Delete snapshot “${snap.name}”? This cannot be undone.`)) return;
  try { await api('DELETE', `/api/snapshots/${snap.id}`); toast('Snapshot deleted'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ---------- settings ---------- */

$('btn-change-project').onclick = () => {
  if (opActive) { toast('Wait for the current operation to finish', 'err'); return; }
  openBrowser(async p => {
    try {
      await api('POST', '/api/project', { path: p });
      addRecent(p);
      await refresh();
      toast('Project switched to ' + p, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
};

$('btn-settings').onclick = () => {
  if (!state) return;
  $('set-backup-path').value = state.settings.backupPath || '';
  $('set-gitignore').checked = !!state.settings.respectGitignore;
  $('set-preserve').checked = state.settings.preserveIgnoredOnRestore !== false;
  $('set-auto-hours').value = Number(state.settings.autoSnapshotHours) || 0;
  $('set-watch').checked = state.settings.watchEnabled !== false;
  $('set-agent-snap').checked = !!state.settings.autoSnapshotBeforeAgent;
  $('set-session-snap').checked = !!state.settings.autoSnapAfterSession;
  ignoreRows = (state.settings.manualIgnores || []).map(r => ({ ...r }));
  renderIgnoreTable();
  $('settings-overlay').classList.remove('hidden');
};
$('settings-close').onclick = () => $('settings-overlay').classList.add('hidden');
$('settings-overlay').addEventListener('click', e => { if (e.target === $('settings-overlay')) $('settings-overlay').classList.add('hidden'); });

$('ignore-add').onclick = () => {
  ignoreRows.push({ id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6), type: 'folder', value: '' });
  renderIgnoreTable();
};

function renderIgnoreTable() {
  const box = $('ignore-table');
  box.innerHTML = '';
  ignoreRows.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'ignore-row';
    div.innerHTML = `
      <select>
        ${['folder', 'file', 'glob'].map(t => `<option value="${t}" ${row.type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <input type="text" placeholder="${row.type === 'glob' ? '*.log' : 'path/relative/to/project'}" value="${esc(row.value)}" spellcheck="false" />
      <button class="ignore-del" title="Remove">✕</button>`;
    div.querySelector('select').onchange = e => { row.type = e.target.value; renderIgnoreTable(); };
    div.querySelector('input').oninput = e => { row.value = e.target.value; };
    div.querySelector('.ignore-del').onclick = () => { ignoreRows.splice(i, 1); renderIgnoreTable(); };
    box.appendChild(div);
  });
  if (!ignoreRows.length) box.innerHTML = '<p class="hint" style="margin:0">Nothing ignored manually. Press + to add a rule.</p>';
}

$('settings-save').onclick = async () => {
  try {
    state = await api('PUT', '/api/settings', {
      backupPath: $('set-backup-path').value.trim(),
      respectGitignore: $('set-gitignore').checked,
      preserveIgnoredOnRestore: $('set-preserve').checked,
      autoSnapshotHours: Math.max(0, Number($('set-auto-hours').value) || 0),
      watchEnabled: $('set-watch').checked,
      autoSnapshotBeforeAgent: $('set-agent-snap').checked,
      autoSnapAfterSession: $('set-session-snap').checked,
      manualIgnores: ignoreRows.filter(r => r.value.trim()).map(r => ({ type: r.type, value: r.value.trim() }))
    });
    render();
    $('settings-overlay').classList.add('hidden');
    toast('Settings saved', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

/* ---------- live dirty state ---------- */

async function updateNowMarker(count) {
  const el = $('now-label');
  if (!el) return;
  const marker = el.closest('.now-marker');
  if (count > 0) {
    el.textContent = `NOW — ${count} file${count === 1 ? '' : 's'} changed`;
    marker.classList.add('dirty');
  } else {
    el.textContent = 'NOW — current code';
    marker.classList.remove('dirty');
  }
}

async function showDirtyPanel() {
  try {
    const d = await api('GET', '/api/dirty');
    if (!d.watching) { toast('Live change detection is off — enable it in Settings'); return; }
    const icon = { add: '+', change: '~', unlink: '−' };
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal-box" style="width:min(560px,94vw);max-height:86vh;overflow-y:auto">
        <div class="micro-label">Unsaved changes</div>
        <p class="modal-text" style="font-size:14px">${d.count} file${d.count === 1 ? '' : 's'} changed since last snapshot${d.session.agent ? ' · <strong>AI agent session</strong>' : ''}</p>
        ${d.count ? `<div class="diff-list" style="max-height:300px">${d.files.map(f => `<div class="diff-file ${f.type === 'add' ? 'add' : f.type === 'unlink' ? 'rem' : 'chg'}">${icon[f.type]} ${esc(f.path)}</div>`).join('')}</div>` : '<p class="hint">Working tree is clean — everything is captured.</p>'}
        <div class="modal-actions"><button class="btn primary" onclick="this.closest('.overlay').remove()">Close</button></div>
      </div>`;
    document.body.appendChild(ov);
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- SSE progress ---------- */

const es = new EventSource('/api/events');
es.onmessage = ev => {
  try {
    const d = JSON.parse(ev.data);
    if (d.type === 'refresh') { refresh(); updateNowMarker(0); return; }
    if (d.type === 'dirty') { updateNowMarker(d.count); return; }
    if (d.type !== 'progress') return;
    opActive = d.phase !== 'done';
    $('busy-dot').classList.toggle('on', opActive);

    const isSnap = d.op === 'snapshot';
    $('prog-op').textContent = isSnap ? 'SNAPSHOT' : (d.phase === 'safety' ? 'SAFETY SNAPSHOT' : 'RESTORE');
    $('prog-pct').firstChild.textContent = d.phase === 'scan' ? '·' : (d.pct || 0);
    $('prog-fill').style.width = (d.phase === 'scan' ? 4 : (d.pct || 0)) + '%';
    $('prog-msg').textContent = d.message || '';

    if (d.phase === 'done') {
      setTimeout(hideProg, 600);
      toast(isSnap ? 'Snapshot saved' : 'Restore complete — codebase replaced', 'ok');
      refresh();
    } else {
      $('prog').classList.remove('hidden');
    }
  } catch { }
};

function hideProg() {
  $('prog').classList.add('hidden');
  $('busy-dot').classList.remove('on');
  opActive = false;
}

document.querySelector('.now-marker').addEventListener('click', showDirtyPanel);

/* ---------- boot ---------- */

renderRecents();
refresh();
updateNowMarker(0);
