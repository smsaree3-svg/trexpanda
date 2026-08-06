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
    if (tab.dataset.view === 'friends') refreshCloud();
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
    const att = s.attachment ? ' <span title="' + esc(s.attachment.name) + '">📎 ' + esc(s.attachment.name) + '</span>' : '';
    const rich = s.html ? ' <span class="pill ok" title="Formatted (rich text)" style="padding:1px 7px">styled</span>' : '';
    tr.innerHTML =
      '<td><code>' + esc(s.trigger) + '</code></td>' +
      '<td class="repl">' + esc(oneLine(s.replacement)) + rich + att + '</td>' +
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
let editAttachment = null; // {type, name, mime, data} while editing

function openEditor(index) {
  editIndex = index;
  const s = index >= 0 ? state.personal[index] : { trigger: '', replacement: '', enabled: true };
  $('modal-title').textContent = index >= 0 ? 'Edit snippet' : 'New snippet';
  $('edit-trigger').value = s.trigger || '';
  // The "Expands to" field is now a rich-text editor. Load stored HTML if the
  // snippet has it, otherwise show the plain text (newlines preserved).
  $('edit-repl').innerHTML = s.html ? s.html : textToHtml(s.replacement || '');
  $('edit-enabled').checked = s.enabled !== false;
  editAttachment = s.attachment || null;
  renderAttachment();
  $('modal').classList.add('show');
  $('edit-trigger').focus();
}
function closeEditor() { $('modal').classList.remove('show'); }

function renderAttachment() {
  const preview = $('attach-preview');
  const thumb = $('attach-thumb');
  const name = $('attach-name');
  const btn = $('btn-attach');
  if (editAttachment) {
    preview.style.display = 'inline-flex';
    btn.textContent = '📎 Replace…';
    name.textContent = editAttachment.name + (editAttachment.type === 'image' ? ' (image)' : ' (file)');
    if (editAttachment.type === 'image') {
      thumb.style.display = 'inline-block';
      thumb.src = 'data:' + (editAttachment.mime || 'image/png') + ';base64,' + editAttachment.data;
    } else {
      thumb.style.display = 'none';
    }
  } else {
    preview.style.display = 'none';
    thumb.style.display = 'none';
    btn.textContent = '📎 Attach image or file…';
  }
}

function onAttachFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result);
    const comma = dataUrl.indexOf(',');
    const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    editAttachment = {
      type: (file.type || '').startsWith('image/') ? 'image' : 'file',
      name: file.name || 'attachment',
      mime: file.type || '',
      data,
    };
    renderAttachment();
  };
  reader.readAsDataURL(file);
}

async function saveSnippet() {
  const trigger = $('edit-trigger').value.trim();
  if (!trigger) { $('edit-trigger').focus(); return; }
  const editor = $('edit-repl');
  const html = sanitizeHtml(editor.innerHTML);
  const text = editor.innerText; // plain-text fallback (preserves line breaks)
  const snippet = {
    trigger,
    replacement: text,
    label: trigger,
    enabled: $('edit-enabled').checked,
    origin: 'personal',
  };
  // Only keep the HTML variant when it actually carries formatting; a plain
  // paragraph of text expands fine (and syncs smaller) without it.
  if (isFormatted(html)) snippet.html = html;
  if (editAttachment) snippet.attachment = editAttachment;
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

// ---- CSV import / export --------------------------------------------------
// Parse RFC-4180-style CSV: quoted fields, commas & newlines inside quotes,
// and "" as an escaped quote. Returns an array of string arrays (rows).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  // Normalise line endings so \r\n and \r behave like \n.
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  // Flush trailing field/row (unless the input ended on a clean newline).
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && r.some((v) => v.trim() !== ''));
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function setImportStatus(text, kind) {
  const el = $('import-status');
  el.style.display = 'inline-block';
  el.textContent = text;
  el.className = 'pill ' + (kind || '');
}

// Column headers we understand (case-insensitive). Anything else falls back to
// positional order: column 1 = trigger, column 2 = replacement, column 3 = label.
function importCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) { setImportStatus('empty file - nothing to import', 'bad'); return; }

  const norm = (h) => String(h || '').trim().toLowerCase();
  const header = rows[0].map(norm);
  const known = ['trigger', 'shortcut', 'abbreviation', 'replacement', 'expansion', 'expands to', 'text', 'value', 'label', 'name', 'description'];
  const hasHeader = header.some((h) => known.includes(h));

  let iTrig = 0, iRepl = 1, iLabel = 2;
  if (hasHeader) {
    const find = (names) => header.findIndex((h) => names.includes(h));
    iTrig = find(['trigger', 'shortcut', 'abbreviation']);
    iRepl = find(['replacement', 'expansion', 'expands to', 'text', 'value']);
    iLabel = find(['label', 'name', 'description']);
  }
  if (iTrig < 0) iTrig = 0;
  if (iRepl < 0) iRepl = 1;

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const list = (state.personal || []).slice();
  const indexByTrigger = new Map();
  list.forEach((s, i) => indexByTrigger.set(s.trigger, i));

  let added = 0, updated = 0, skipped = 0;
  for (const r of dataRows) {
    const trigger = (r[iTrig] || '').trim();
    const replacement = iRepl >= 0 ? (r[iRepl] || '') : '';
    const label = (iLabel >= 0 && r[iLabel] != null && r[iLabel].trim()) ? r[iLabel].trim() : trigger;
    if (!trigger) { skipped++; continue; }
    const snippet = { trigger, replacement, label, enabled: true, origin: 'personal' };
    if (indexByTrigger.has(trigger)) {
      const existing = list[indexByTrigger.get(trigger)];
      if (existing.attachment) snippet.attachment = existing.attachment; // keep any attachment
      list[indexByTrigger.get(trigger)] = snippet;
      updated++;
    } else {
      indexByTrigger.set(trigger, list.length);
      list.push(snippet);
      added++;
    }
  }

  if (!added && !updated) { setImportStatus('no valid rows found (need a trigger column)', 'bad'); return; }

  window.api.savePersonal(list).then(() => {
    const parts = [];
    if (added) parts.push(added + ' added');
    if (updated) parts.push(updated + ' updated');
    if (skipped) parts.push(skipped + ' skipped');
    setImportStatus('imported: ' + parts.join(', '), 'ok');
    refresh();
  });
}

function exportCSV() {
  const list = state.personal || [];
  const lines = ['trigger,replacement,label'];
  list.forEach((s) => {
    lines.push([csvCell(s.trigger), csvCell(s.replacement), csvCell(s.label || s.trigger)].join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'trexpanda-macros.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- helpers --------------------------------------------------------------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 90); }

// ---- rich-text editor helpers ---------------------------------------------
// Stored plain text -> safe HTML for the editor (newlines become <br>).
function textToHtml(text) { return esc(text).replace(/\n/g, '<br>'); }

// True when the HTML carries real formatting (not just a plain line of text),
// so we only store the heavier HTML variant when it's actually needed.
function isFormatted(html) {
  const stripped = String(html).replace(/<br\s*\/?>(?=)/gi, '').replace(/<div>|<\/div>/gi, '').trim();
  return /<(b|strong|i|em|u|s|ul|ol|li|a|img|h[1-6]|blockquote|code|pre|span)\b|style=/i.test(stripped);
}

// Strip anything unsafe before we store or inject the HTML: script/style/etc.,
// inline event handlers, and javascript: URLs.
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  doc.querySelectorAll('script,style,meta,link,iframe,object,embed').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    });
  });
  return doc.body.innerHTML;
}

// Save/restore the editor selection so toolbar actions (esp. the link input,
// which steals focus) apply to the text the user had selected.
let rtSavedRange = null;
function rtSaveSelection() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) rtSavedRange = sel.getRangeAt(0).cloneRange();
}
function rtRestoreSelection() {
  if (!rtSavedRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(rtSavedRange);
}

async function refresh() { state = await window.api.getState(); render(); }

// ---- wire up --------------------------------------------------------------
$('btn-add').addEventListener('click', () => openEditor(-1));
$('btn-cancel').addEventListener('click', closeEditor);
$('btn-save-snippet').addEventListener('click', saveSnippet);
$('btn-save-settings').addEventListener('click', saveSettings);
$('btn-sync').addEventListener('click', syncNow);
$('btn-choose-folder').addEventListener('click', choosePublishFolder);
$('btn-publish').addEventListener('click', publish);
$('btn-import').addEventListener('click', () => $('import-input').click());
$('btn-export').addEventListener('click', exportCSV);
$('import-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => importCSV(String(reader.result));
  reader.onerror = () => setImportStatus('could not read file', 'bad');
  reader.readAsText(file);
});
$('btn-attach').addEventListener('click', () => $('attach-input').click());
$('attach-input').addEventListener('change', (e) => { onAttachFile(e.target.files[0]); e.target.value = ''; });
$('btn-attach-remove').addEventListener('click', () => { editAttachment = null; renderAttachment(); });

// ---- rich-text toolbar ----------------------------------------------------
// Keep the editor's text selection when a toolbar button is pressed.
$('rt-toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
$('rt-toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.id === 'rt-image') { rtSaveSelection(); $('rt-image-input').click(); return; }
  const cmd = btn.dataset.cmd;
  if (!cmd) return;
  if (cmd === 'createLink') {
    rtSaveSelection();
    const row = $('rt-link-row');
    row.style.display = 'flex';
    $('rt-link-url').value = '';
    $('rt-link-url').focus();
    return;
  }
  $('edit-repl').focus();
  document.execCommand(cmd, false, null);
});
$('rt-image-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => { $('edit-repl').focus(); rtRestoreSelection(); document.execCommand('insertImage', false, String(reader.result)); };
  reader.readAsDataURL(file);
});
$('rt-link-apply').addEventListener('click', () => {
  const url = $('rt-link-url').value.trim();
  $('rt-link-row').style.display = 'none';
  $('edit-repl').focus();
  rtRestoreSelection();
  if (url) document.execCommand('createLink', false, url);
});
$('rt-link-cancel').addEventListener('click', () => { $('rt-link-row').style.display = 'none'; $('edit-repl').focus(); });
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeEditor(); });

// ===========================================================================
// Cloud: accounts, friends & library sharing
// ===========================================================================

let cloud = {
  status: { configured: false, signedIn: false, user: null },
  myLibId: null,
  sharedWith: new Set(), // friend userIds my library is shared with
  friends: { friends: [], incoming: [], outgoing: [] },
  shared: [], // libraries shared WITH me
  subs: new Set(), // library ids I've turned on
};

function cc(method, ...args) {
  return window.api.cloud.call(method, ...args).then((r) => r || { ok: false, error: 'no response' });
}
function initial(s) { return (String(s || '?').trim()[0] || '?').toUpperCase(); }

async function refreshCloud() {
  const st = await cc('status');
  cloud.status = st.ok ? st.data : { configured: false, signedIn: false, reason: st.error };
  renderCloud();
  if (!cloud.status.configured || !cloud.status.signedIn) return;

  const [lib, fr, sh, subs] = await Promise.all([
    cc('ensureDefaultLibrary'), cc('listFriends'), cc('sharedWithMe'), cc('getSubscriptions'),
  ]);
  cloud.myLibId = lib.ok ? lib.data.id : null;
  cloud.friends = fr.ok ? fr.data : { friends: [], incoming: [], outgoing: [] };
  cloud.shared = sh.ok ? sh.data : [];
  cloud.subs = new Set(subs.ok ? subs.data : []);
  cloud.sharedWith = new Set();
  if (cloud.myLibId) {
    const shares = await cc('listShares', cloud.myLibId);
    if (shares.ok) cloud.sharedWith = new Set(shares.data.map((x) => x.userId));
  }
  renderCloud();
}

function renderCloud() {
  const s = cloud.status || {};
  const pill = $('pill-account');
  if (s.signedIn && s.user) { pill.textContent = '@' + (s.user.username || 'you'); pill.className = 'pill ok'; }
  else { pill.textContent = 'signed out'; pill.className = 'pill'; }

  const un = $('cloud-unavailable');
  const auth = $('auth-panel');
  const acct = $('account-panel');
  if (!s.configured) {
    un.style.display = 'block';
    un.textContent = "⚠️ Cloud sharing isn't set up in this build. " + (s.reason || '') + ' See CLOUD_SETUP.md to connect a Supabase project.';
    auth.style.display = 'none'; acct.style.display = 'none';
    return;
  }
  un.style.display = 'none';
  if (s.signedIn) { auth.style.display = 'none'; acct.style.display = 'block'; renderAccount(); }
  else { auth.style.display = 'block'; acct.style.display = 'none'; }
}

function renderAccount() {
  const u = cloud.status.user || {};
  $('me-name').textContent = u.displayName || u.username || 'You';
  $('me-username').textContent = '@' + (u.username || '');
  $('me-avatar').textContent = initial(u.displayName || u.username);
  $('set-autopublish').checked = !!(state.settings && state.settings.publishToCloud);

  const inc = cloud.friends.incoming || [];
  $('incoming-wrap').style.display = inc.length ? 'block' : 'none';
  $('incoming-list').innerHTML = inc.map((x) => friendRow(x, 'incoming')).join('');

  const out = cloud.friends.outgoing || [];
  $('outgoing-wrap').style.display = out.length ? 'block' : 'none';
  $('outgoing-list').innerHTML = out.map((x) => friendRow(x, 'outgoing')).join('');

  const fr = cloud.friends.friends || [];
  $('friends-empty').style.display = fr.length ? 'none' : 'block';
  $('friends-list').innerHTML = fr.map((x) => friendRow(x, 'friend')).join('');

  const sh = cloud.shared || [];
  $('shared-empty').style.display = sh.length ? 'none' : 'block';
  $('shared-list').innerHTML = sh.map(sharedRow).join('');

  wireCloudRows();
}

function friendRow(x, kind) {
  const p = x.profile || {};
  const name = esc(p.display_name || p.username || 'Unknown user');
  const uname = esc('@' + (p.username || 'user'));
  let actions = '';
  if (kind === 'incoming') {
    actions = `<button class="primary" data-accept="${x.friendshipId}">Accept</button>` +
      `<button class="danger" data-decline="${x.friendshipId}">Decline</button>`;
  } else if (kind === 'outgoing') {
    actions = `<span class="chip">pending</span>` +
      `<button class="danger" data-cancel="${x.friendshipId}">Cancel</button>`;
  } else {
    const on = cloud.sharedWith.has(x.userId);
    actions = `<span class="chip ${on ? 'on' : ''}">${on ? 'shared' : 'not shared'}</span>` +
      `<button data-share="${x.userId}" data-on="${on ? 1 : 0}">${on ? 'Unshare' : 'Share'}</button>` +
      `<button class="danger" data-unfriend="${x.friendshipId}">Remove</button>`;
  }
  return `<div class="list-row"><div class="avatar">${initial(p.display_name || p.username)}</div>` +
    `<div class="who"><strong>${name}</strong><span class="uname">${uname}</span></div>` +
    `<div class="grow"></div><div class="actions">${actions}</div></div>`;
}

function sharedRow(l) {
  const owner = l.owner || {};
  const on = cloud.subs.has(l.id);
  return `<div class="list-row"><div class="avatar">${initial(owner.display_name || owner.username)}</div>` +
    `<div class="who"><strong>${esc(l.name || 'Library')}</strong>` +
    `<span class="uname">from @${esc(owner.username || 'user')}</span></div>` +
    `<div class="grow"></div><div class="actions">` +
    `<span class="chip ${on ? 'on' : ''}">${on ? 'on' : 'off'}</span>` +
    `<button data-sub="${l.id}" data-on="${on ? 1 : 0}">${on ? 'Turn off' : 'Use these'}</button>` +
    `</div></div>`;
}

function wireCloudRows() {
  const bind = (attr, fn) => document.querySelectorAll('[' + attr + ']').forEach((b) =>
    b.addEventListener('click', () => fn(b)));
  bind('data-accept', (b) => respond(b.dataset.accept, true));
  bind('data-decline', (b) => respond(b.dataset.decline, false));
  bind('data-cancel', (b) => removeFriend(b.dataset.cancel));
  bind('data-unfriend', (b) => removeFriend(b.dataset.unfriend));
  bind('data-share', (b) => toggleShare(b.dataset.share, b.dataset.on === '1'));
  bind('data-sub', (b) => toggleSub(b.dataset.sub, b.dataset.on === '1'));
}

// ---- cloud actions --------------------------------------------------------
function authError(msg) {
  const el = $('auth-error');
  if (!msg) { el.style.display = 'none'; return; }
  el.style.display = 'block'; el.textContent = msg;
}

async function doSignIn() {
  authError('');
  const email = $('si-email').value.trim();
  const password = $('si-password').value;
  if (!email || !password) { authError('Enter your email and password.'); return; }
  const btn = $('btn-signin'); btn.disabled = true; btn.textContent = 'Signing in…';
  const res = await cc('signIn', { email, password });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (!res.ok) { authError(res.error); return; }
  $('si-password').value = '';
  await refreshCloud();
  window.api.syncNow();
}

async function doSignUp() {
  authError('');
  const username = $('su-username').value.trim();
  const displayName = $('su-display').value.trim();
  const email = $('su-email').value.trim();
  const password = $('su-password').value;
  if (!username || !email || !password) { authError('Username, email and password are required.'); return; }
  const btn = $('btn-signup'); btn.disabled = true; btn.textContent = 'Creating…';
  const res = await cc('signUp', { email, password, username, displayName });
  btn.disabled = false; btn.textContent = 'Create account';
  if (!res.ok) { authError(res.error); return; }
  if (res.data && res.data.needsConfirmation) {
    authError('Account created. Check your email to confirm, then sign in. (Tip: disable email confirmation in Supabase for instant sign-in.)');
    setAuthMode('signin');
    return;
  }
  await refreshCloud();
  window.api.syncNow();
}

async function doGoogle() {
  authError('');
  const btn = $('btn-google');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Opening your browser… complete sign-in there';
  const res = await cc('signInWithGoogle');
  btn.disabled = false;
  btn.innerHTML = original;
  if (!res.ok) { authError(res.error || 'Google sign-in failed.'); return; }
  await refreshCloud();
  window.api.syncNow();
}

async function doSignOut() {
  await cc('signOut');
  await refreshCloud();
  window.api.syncNow();
}

async function addFriend() {
  const input = $('add-friend-input');
  const uname = input.value.trim();
  const status = $('add-friend-status');
  if (!uname) return;
  const res = await cc('sendFriendRequest', uname);
  status.style.display = 'inline-block';
  if (res.ok) { status.className = 'pill ok'; status.textContent = 'Request sent to @' + res.data.to; input.value = ''; }
  else { status.className = 'pill bad'; status.textContent = res.error; }
  refreshCloud();
}

async function respond(id, accept) { await cc('respondToRequest', id, accept); refreshCloud(); window.api.syncNow(); }
async function removeFriend(id) { await cc('removeFriend', id); refreshCloud(); }

async function toggleShare(userId, currentlyOn) {
  if (!cloud.myLibId) {
    const l = await cc('ensureDefaultLibrary');
    cloud.myLibId = l.ok ? l.data.id : null;
  }
  if (!cloud.myLibId) return;
  if (currentlyOn) await cc('unshareLibrary', cloud.myLibId, userId);
  else {
    await cc('shareLibrary', cloud.myLibId, userId);
    await cc('publishPersonal'); // make sure the friend gets current snippets
  }
  refreshCloud();
}

async function toggleSub(libId, currentlyOn) {
  const next = new Set(cloud.subs);
  if (currentlyOn) next.delete(libId); else next.add(libId);
  await cc('setSubscriptions', [...next]);
  await refreshCloud();
  refresh(); // main re-synced the cloud cache; refresh Team view
}

async function publishCloud() {
  const status = $('publish-cloud-status');
  const btn = $('btn-publish-cloud'); btn.disabled = true; btn.textContent = 'Publishing…';
  const res = await cc('publishPersonal');
  btn.disabled = false; btn.textContent = 'Publish my snippets';
  status.style.display = 'inline-block';
  if (res.ok) { status.className = 'pill ok'; status.textContent = 'Published ' + res.data.count + ' snippet' + (res.data.count === 1 ? '' : 's'); }
  else { status.className = 'pill bad'; status.textContent = res.error; }
}

async function setAutoPublish() {
  await cc('setPublishToCloud', $('set-autopublish').checked);
  refresh();
}

function setAuthMode(mode) {
  document.querySelectorAll('.authtab').forEach((t) => t.classList.toggle('active', t.dataset.auth === mode));
  $('auth-signin').style.display = mode === 'signin' ? 'block' : 'none';
  $('auth-signup').style.display = mode === 'signup' ? 'block' : 'none';
  authError('');
}

// ---- cloud wire-up --------------------------------------------------------
document.querySelectorAll('.authtab').forEach((t) =>
  t.addEventListener('click', () => setAuthMode(t.dataset.auth)));
$('btn-google').addEventListener('click', doGoogle);
$('btn-signin').addEventListener('click', doSignIn);
$('btn-signup').addEventListener('click', doSignUp);
$('btn-signout').addEventListener('click', doSignOut);
$('btn-add-friend').addEventListener('click', addFriend);
$('add-friend-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFriend(); });
$('btn-publish-cloud').addEventListener('click', publishCloud);
$('set-autopublish').addEventListener('change', setAutoPublish);

window.api.onState((s) => { state = s; render(); });
window.api.cloud.onChange(() => refreshCloud());
refresh();
refreshCloud();
