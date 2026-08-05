'use strict';

// Renderer logic. Talks to the main process only through window.api (preload).

let state = { personal: [], team: [], settings: {}, stats: {}, engine: {} };
let editIndex = -1; // -1 = new snippet

const $ = (id) => document.getElementById(id);

// ---- tabs -----------------------------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    $('view-' + tab.dataset.view).classList.add('active');
  });
});

// ---- render ---------------------------------------------------------------
function render() {
  renderStatus();
  renderSnippets();
  renderTeam();
  renderSettings();
}

function renderStatus() {
  const e = state.engine || {};
  const s = state.settings || {};
  setPill('pill-expansion', s.enabled ? 'expansion on' : 'expansion off', s.enabled);
  setPill('pill-hook', e.hookAvailable ? 'keyboard hook ✓' : 'hook missing', e.hookAvailable);
  setPill('pill-inject', e.injectionAvailable ? 'inject ✓' : 'inject missing', e.injectionAvailable);

  const banner = $('engine-banner');
  const problems = [];
  if (!e.hookAvailable) problems.push(`Global keyboard capture is unavailable${e.hookError ? ' (' + e.hookError + ')' : ''}. On macOS, grant Accessibility permission in System Settings → Privacy & Security → Accessibility, then reopen.`);
  if (!e.injectionAvailable) problems.push(`Keystroke injection is unavailable${e.injectionError ? ' (' + e.injectionError + ')' : ''}. Snippets can be managed but won't expand until this is resolved.`);
  if (problems.length) {
    banner.className = 'banner';
    banner.innerHTML = problems.map((p) => '<div>⚠️ ' + p + '</div>').join('');
  } else {
    banner.className = '';
    banner.innerHTML = '';
  }
}

function setPill(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = 'pill ' + (ok ? 'ok' : 'bad');
}

function renderSnippets() {
  const rows = $('snip-rows');
  rows.innerHTML = '';
  const list = state.personal || [];
  $('snip-empty').style.display = list.length ? 'none' : 'block';
  $('count').textContent = list.length + ' snippet' + (list.length === 1 ? '' : 's');
  list.forEach((s, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><code>' + esc(s.trigger) + '</code></td>' +
      '<td class="repl">' + esc(oneLine(s.replacement)) + '</td>' +
      '<td class="row-actions" style="text-align:right">' +
      '<button data-edit="' + i + '">Edit</button>' +
      '<button class="danger" data-del="' + i + '">Delete</button></td>';
    rows.appendChild(tr);
  });
  rows.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openEditor(+b.dataset.edit)));
  rows.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteSnippet(+b.dataset.del)));
}

function renderTeam() {
  const rows = $('team-rows');
  rows.innerHTML = '';
  const list = state.team || [];
  $('team-empty').style.display = list.length ? 'none' : 'block';
  list.forEach((s) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><code>' + esc(s.trigger) + '</code></td>' +
      '<td class="repl">' + esc(oneLine(s.replacement)) + '</td>' +
      '<td>' + esc(s.label || '') + '</td>';
    rows.appendChild(tr);
  });
  const st = state.stats || {};
  const status = $('sync-status');
  if (st.lastSyncError) { status.textContent = 'sync error: ' + st.lastSyncError; status.className = 'pill bad'; }
  else if (st.lastSyncAt) { status.textContent = 'synced ' + new Date(st.lastSyncAt).toLocaleString(); status.className = 'pill ok'; }
  else { status.textContent = 'not synced yet'; status.className = 'pill'; }
}

function renderSettings() {
  const s = state.settings || {};
  $('set-source').value = s.teamSource || '';
  $('set-interval').value = s.syncIntervalMin || 30;
  $('set-teamwins').value = String(!!s.teamWins);
  $('set-enabled').checked = s.enabled !== false;
  $('set-launch').checked = !!s.launchAtLogin;
}

// ---- snippet editor -------------------------------------------------------
function openEditor(index) {
  editIndex = index;
  const s = index >= 0 ? state.personal[index] : { trigger: '', replacement: '', enabled: true };
  $('modal-title').textContent = index >= 0 ? 'Edit snippet' : 'New snippet';
  $('edit-trigger').value = s.trigger || '';
  $('edit-repl').value = s.replacement || '';
  $('edit-enabled').checked = s.enabled !== false;
  $('modal').classList.add('show');
  $('edit-trigger').focus();
}
function closeEditor() { $('modal').classList.remove('show'); }

async function saveSnippet() {
  const trigger = $('edit-trigger').value.trim();
  if (!trigger) { $('edit-trigger').focus(); return; }
  const snippet = {
    trigger,
    replacement: $('edit-repl').value,
    label: trigger,
    enabled: $('edit-enabled').checked,
    origin: 'personal',
  };
  const list = (state.personal || []).slice();
  if (editIndex >= 0) list[editIndex] = snippet; else list.push(snippet);
  await window.api.savePersonal(list);
  closeEditor();
  refresh();
}

async function deleteSnippet(index) {
  const list = (state.personal || []).slice();
  list.splice(index, 1);
  await window.api.savePersonal(list);
  refresh();
}

// ---- settings actions -----------------------------------------------------
async function saveSettings() {
  await window.api.saveSettings({
    teamSource: $('set-source').value.trim(),
    syncIntervalMin: Number($('set-interval').value) || 30,
    teamWins: $('set-teamwins').value === 'true',
    enabled: $('set-enabled').checked,
    launchAtLogin: $('set-launch').checked,
  });
  refresh();
}

async function syncNow() {
  const btn = $('btn-sync');
  btn.disabled = true; btn.textContent = 'Syncing…';
  await window.api.syncNow();
  btn.disabled = false; btn.textContent = '↻ Sync now';
  refresh();
}

async function choosePublishFolder() {
  const folder = await window.api.chooseFolder();
  if (folder) $('set-source').dataset.publishFolder = folder, ($('publish-status').textContent = folder, $('publish-status').className = 'pill');
}

async function publish() {
  const folder = $('set-source').dataset.publishFolder;
  if (!folder) { $('publish-status').textContent = 'choose a folder first'; $('publish-status').className = 'pill bad'; return; }
  const res = await window.api.publishLibrary(folder);
  const st = $('publish-status');
  if (res.ok) { st.textContent = 'published → ' + res.target; st.className = 'pill ok'; }
  else { st.textContent = 'error: ' + res.error; st.className = 'pill bad'; }
}

// ---- helpers --------------------------------------------------------------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 90); }

async function refresh() { state = await window.api.getState(); render(); }

// ---- wire up --------------------------------------------------------------
$('btn-add').addEventListener('click', () => openEditor(-1));
$('btn-cancel').addEventListener('click', closeEditor);
$('btn-save-snippet').addEventListener('click', saveSnippet);
$('btn-save-settings').addEventListener('click', saveSettings);
$('btn-sync').addEventListener('click', syncNow);
$('btn-choose-folder').addEventListener('click', choosePublishFolder);
$('btn-publish').addEventListener('click', publish);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeEditor(); });

window.api.onState((s) => { state = s; render(); });
refresh();
