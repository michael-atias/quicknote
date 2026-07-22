// QuickNote - Popup logic
// Tabs: Notes manager, Cheat sheet, Backup.

'use strict';

// Snippets are fully user-owned and stored in chrome.storage.local under
// `snippets`. Ready-made packs can be imported from JSON files (see the
// cheatsheets/ folder in the repo). Each snippet: { id, label, text, category }.

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () { return fallback(text); });
  }
  return fallback(text);
  function fallback(t) {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* no-op */ }
    ta.remove();
    return Promise.resolve();
  }
}

function hostFromUrl(url) {
  try { return new URL(url).host; } catch (e) { return url; }
}

// --- Import validation (defense-in-depth) -----------------------------------
// Every note that comes from an imported file is passed through this so only
// well-formed, bounded values ever reach storage.
function num(v, def) { var n = Number(v); return isFinite(n) ? n : def; }

function sanitizeNote(n) {
  if (!n || typeof n !== 'object') return null;
  return {
    id: typeof n.id === 'string' && n.id ? n.id
      : 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    content: typeof n.content === 'string' ? n.content : '',
    x: Math.max(0, num(n.x, 40)),
    y: Math.max(0, num(n.y, 40)),
    width: Math.min(1600, Math.max(160, num(n.width, 260))),
    height: Math.min(1600, Math.max(80, num(n.height, 190))),
    color: toHex(n.color),
    scope: n.scope === 'global' ? 'global' : 'page',
    mono: !!n.mono,
    createdAt: num(n.createdAt, Date.now()),
    updatedAt: num(n.updatedAt, Date.now())
  };
}

// --- Placeholders ({{name}}) -------------------------------------------------
var PLACEHOLDER_RE = /\{\{\s*([\w.\- ]+?)\s*\}\}/g;

function findPlaceholders(text) {
  var names = [];
  var seen = {};
  var m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    var name = m[1];
    if (!seen[name]) { seen[name] = true; names.push(name); }
  }
  return names;
}

function applyPlaceholders(text, values) {
  return text.replace(PLACEHOLDER_RE, function (whole, name) {
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole;
  });
}

// Resolves to the filled text, or null if the user cancels. If the snippet has
// no placeholders it resolves immediately. Uses an in-popup overlay (browser
// prompt() would close the popup).
function resolvePlaceholders(text) {
  return new Promise(function (resolve) {
    var names = findPlaceholders(text);
    if (names.length === 0) { resolve(text); return; }

    var overlay = document.createElement('div');
    overlay.className = 'ph-overlay';

    var box = document.createElement('div');
    box.className = 'ph-box';

    var title = document.createElement('div');
    title.className = 'ph-title';
    title.textContent = 'Fill in the fields';
    box.appendChild(title);

    var inputs = {};
    names.forEach(function (name) {
      var label = document.createElement('label');
      label.className = 'ph-label';
      label.textContent = name;
      var input = document.createElement('input');
      input.className = 'ph-input';
      input.type = 'text';
      input.setAttribute('data-name', name);
      label.appendChild(input);
      box.appendChild(label);
      inputs[name] = input;
    });

    var actions = document.createElement('div');
    actions.className = 'ph-actions';
    var cancel = document.createElement('button');
    cancel.className = 'btn-mini';
    cancel.textContent = 'Cancel';
    var ok = document.createElement('button');
    ok.className = 'btn-mini btn-mini-primary';
    ok.textContent = 'Copy';
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(actions);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    var firstInput = inputs[names[0]];
    if (firstInput) firstInput.focus();

    function close(result) { overlay.remove(); resolve(result); }

    function submit() {
      var values = {};
      names.forEach(function (name) { values[name] = inputs[name].value; });
      close(applyPlaceholders(text, values));
    }

    cancel.onclick = function () { close(null); };
    ok.onclick = submit;
    overlay.onclick = function (e) { if (e.target === overlay) close(null); };
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
  });
}

var LEGACY_COLORS = { yellow: '#fde047', blue: '#93c5fd', green: '#86efac', pink: '#f9a8d4' };
function toHex(value) {
  if (typeof value === 'string') {
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
    if (LEGACY_COLORS[value]) return LEGACY_COLORS[value];
  }
  return '#fde047';
}

function flash(el, cls) {
  el.classList.add(cls);
  setTimeout(function () { el.classList.remove(cls); }, 1000);
}

// ---------------------------------------------------------------------------
// Load all notes (page buckets + global) into a flat list for the manager.
// ---------------------------------------------------------------------------
function getAllNotes(cb) {
  chrome.storage.local.get(['notes', 'global'], function (result) {
    var buckets = result.notes || {};
    var global = result.global || [];
    var flat = [];
    Object.keys(buckets).forEach(function (url) {
      buckets[url].forEach(function (n) {
        flat.push({ note: n, url: url });
      });
    });
    global.forEach(function (n) { flat.push({ note: n, url: null }); });
    cb(flat);
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function renderStats() {
  chrome.runtime.sendMessage({ action: 'getStats' }, function (response) {
    if (chrome.runtime.lastError || !response) return;
    setText('totalNotes', response.totalNotes || 0);
    setText('totalPages', response.totalPages || 0);
    setText('globalNotes', response.globalNotes || 0);
  });
}
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ---------------------------------------------------------------------------
// Notes manager
// ---------------------------------------------------------------------------
var allNotesCache = [];

function renderNotesList(filter) {
  var listEl = document.getElementById('notesList');
  var emptyEl = document.getElementById('notesEmpty');
  listEl.textContent = '';

  var q = (filter || '').toLowerCase();
  var items = allNotesCache.filter(function (entry) {
    if (!q) return true;
    var hay = (entry.note.content || '') + ' ' + (entry.url || 'global');
    return hay.toLowerCase().indexOf(q) !== -1;
  });

  if (allNotesCache.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  if (items.length === 0) {
    var none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'No notes match “' + filter + '”.';
    listEl.appendChild(none);
    return;
  }

  items.forEach(function (entry) {
    listEl.appendChild(buildNoteItem(entry));
  });
}

function buildNoteItem(entry) {
  var note = entry.note;
  var isGlobal = note.scope === 'global';

  var item = document.createElement('div');
  item.className = 'note-item';

  var top = document.createElement('div');
  top.className = 'note-item-top';

  var swatch = document.createElement('span');
  swatch.className = 'note-swatch';
  swatch.style.background = toHex(note.color);
  top.appendChild(swatch);

  if (isGlobal) {
    var badge = document.createElement('span');
    badge.className = 'note-badge';
    badge.textContent = '🌐 Global';
    top.appendChild(badge);
  }

  var host = document.createElement('span');
  host.className = 'note-host';
  host.textContent = isGlobal ? 'every page' : hostFromUrl(entry.url);
  host.title = isGlobal ? 'Shown on every page' : entry.url;
  top.appendChild(host);

  var preview = document.createElement('div');
  preview.className = 'note-preview';
  if (note.content && note.content.trim()) {
    preview.textContent = note.content;
    preview.title = note.content;
  } else {
    preview.className += ' note-empty-preview';
    preview.textContent = '(empty note)';
  }

  var actions = document.createElement('div');
  actions.className = 'note-actions';

  var copyBtn = document.createElement('button');
  copyBtn.className = 'note-action';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = function () {
    copyToClipboard(note.content || '').then(function () {
      copyBtn.textContent = 'Copied ✓';
      copyBtn.classList.add('copied');
      setTimeout(function () { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1000);
    });
  };

  var revealBtn = document.createElement('button');
  revealBtn.className = 'note-action';
  revealBtn.textContent = 'Reveal';
  revealBtn.title = 'Show this note on the current page';
  revealBtn.onclick = function () { revealOnPage(note.id); };

  var delBtn = document.createElement('button');
  delBtn.className = 'note-action note-action-del';
  delBtn.textContent = 'Delete';
  delBtn.onclick = function () { deleteNote(entry); };

  actions.appendChild(copyBtn);
  actions.appendChild(revealBtn);
  actions.appendChild(delBtn);

  item.appendChild(top);
  item.appendChild(preview);
  item.appendChild(actions);
  return item;
}

function revealOnPage(noteId) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'revealNote', noteId: noteId }, function () {
      // Ignore errors (note may belong to a different page); close popup so the
      // user can see the revealed note.
      if (!chrome.runtime.lastError) window.close();
    });
  });
}

function deleteNote(entry) {
  var note = entry.note;
  chrome.storage.local.get(['notes', 'global'], function (result) {
    var buckets = result.notes || {};
    var global = result.global || [];
    if (note.scope === 'global') {
      global = global.filter(function (n) { return n.id !== note.id; });
      chrome.storage.local.set({ global: global }, afterDelete);
    } else {
      if (buckets[entry.url]) {
        buckets[entry.url] = buckets[entry.url].filter(function (n) { return n.id !== note.id; });
        if (buckets[entry.url].length === 0) delete buckets[entry.url];
      }
      chrome.storage.local.set({ notes: buckets }, afterDelete);
    }
  });
  function afterDelete() {
    refreshNotes();
    renderStats();
  }
}

function refreshNotes() {
  getAllNotes(function (flat) {
    allNotesCache = flat;
    var search = document.getElementById('noteSearch');
    renderNotesList(search ? search.value : '');
  });
}

// ---------------------------------------------------------------------------
// Snippets (user-owned cheat sheet)
// ---------------------------------------------------------------------------
var snippets = [];
var editingSnippetId = null;

function loadSnippets(cb) {
  chrome.storage.local.get(['snippets'], function (result) {
    snippets = Array.isArray(result.snippets) ? result.snippets : [];
    if (cb) cb();
  });
}

function persistSnippets(cb) {
  chrome.storage.local.set({ snippets: snippets }, function () { if (cb) cb(); });
}

function renderSnippets(filter) {
  var listEl = document.getElementById('cheatList');
  var emptyEl = document.getElementById('cheatEmpty');
  listEl.textContent = '';

  if (snippets.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  var q = (filter || '').trim().toLowerCase();
  var items = snippets.filter(function (s) {
    if (!q) return true;
    return ((s.text || '') + ' ' + (s.label || '') + ' ' + (s.category || '')).toLowerCase().indexOf(q) !== -1;
  });

  if (items.length === 0) {
    var none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'No snippets match “' + filter + '”.';
    listEl.appendChild(none);
    return;
  }

  // Favorites float to the top in their own group; the rest group by category.
  var favs = items.filter(function (s) { return s.fav; });
  var rest = items.filter(function (s) { return !s.fav; });

  if (favs.length) {
    var favTitle = document.createElement('div');
    favTitle.className = 'cheat-cat-title';
    favTitle.textContent = '★ Favorites';
    listEl.appendChild(favTitle);
    favs.forEach(function (s) { listEl.appendChild(buildSnippetRow(s)); });
  }

  // Group by category (blank category grouped under "Snippets").
  var groups = {};
  var order = [];
  rest.forEach(function (s) {
    var cat = (s.category || '').trim() || 'Snippets';
    if (!groups[cat]) { groups[cat] = []; order.push(cat); }
    groups[cat].push(s);
  });

  order.forEach(function (cat) {
    var title = document.createElement('div');
    title.className = 'cheat-cat-title';
    title.textContent = cat;
    listEl.appendChild(title);
    groups[cat].forEach(function (s) { listEl.appendChild(buildSnippetRow(s)); });
  });
}

function buildSnippetRow(s) {
  var row = document.createElement('div');
  row.className = 'cheat-item';

  var textWrap = document.createElement('div');
  textWrap.className = 'cheat-textwrap';
  textWrap.title = 'Click to copy';

  var payload = document.createElement('span');
  payload.className = 'cheat-payload';
  payload.textContent = s.text;

  textWrap.appendChild(payload);

  var phNames = findPlaceholders(s.text);

  if (s.label || phNames.length) {
    var desc = document.createElement('span');
    desc.className = 'cheat-desc';
    desc.textContent = s.label || '';
    if (phNames.length) {
      var badge = document.createElement('span');
      badge.className = 'cheat-ph';
      badge.textContent = phNames.length + ' field' + (phNames.length > 1 ? 's' : '');
      badge.title = 'Fill on copy: ' + phNames.join(', ');
      if (s.label) desc.appendChild(document.createTextNode(' · '));
      desc.appendChild(badge);
    }
    textWrap.appendChild(desc);
  }

  var actions = document.createElement('div');
  actions.className = 'cheat-actions';

  var favIcon = document.createElement('button');
  favIcon.className = 'cheat-mini cheat-fav' + (s.fav ? ' cheat-fav-on' : '');
  favIcon.title = s.fav ? 'Unfavorite' : 'Favorite (pin to top)';
  favIcon.textContent = s.fav ? '★' : '☆';
  favIcon.onclick = function (e) {
    e.stopPropagation();
    s.fav = !s.fav;
    persistSnippets(function () { renderSnippets(currentCheatFilter()); });
  };

  var copyIcon = document.createElement('button');
  copyIcon.className = 'cheat-mini';
  copyIcon.title = 'Copy';
  copyIcon.textContent = '⧉';

  var editIcon = document.createElement('button');
  editIcon.className = 'cheat-mini';
  editIcon.title = 'Edit';
  editIcon.textContent = '✎';

  var delIcon = document.createElement('button');
  delIcon.className = 'cheat-mini cheat-mini-del';
  delIcon.title = 'Delete';
  delIcon.textContent = '×';

  actions.appendChild(favIcon);
  actions.appendChild(copyIcon);
  actions.appendChild(editIcon);
  actions.appendChild(delIcon);

  row.appendChild(textWrap);
  row.appendChild(actions);

  function doCopy() {
    resolvePlaceholders(s.text).then(function (filled) {
      if (filled == null) return; // user cancelled
      copyToClipboard(filled).then(function () {
        copyIcon.textContent = '✓';
        row.classList.add('copied');
        setTimeout(function () { copyIcon.textContent = '⧉'; row.classList.remove('copied'); }, 1000);
      });
    });
  }

  textWrap.onclick = doCopy;
  copyIcon.onclick = function (e) { e.stopPropagation(); doCopy(); };
  editIcon.onclick = function (e) { e.stopPropagation(); openSnippetEditor(s); };
  delIcon.onclick = function (e) {
    e.stopPropagation();
    snippets = snippets.filter(function (n) { return n.id !== s.id; });
    persistSnippets(function () { renderSnippets(currentCheatFilter()); });
  };

  return row;
}

function currentCheatFilter() {
  var el = document.getElementById('cheatSearch');
  return el ? el.value : '';
}

function openSnippetEditor(snippet) {
  editingSnippetId = snippet ? snippet.id : null;
  document.getElementById('snipLabel').value = snippet ? (snippet.label || '') : '';
  document.getElementById('snipCategory').value = snippet ? (snippet.category || '') : '';
  document.getElementById('snipText').value = snippet ? (snippet.text || '') : '';
  document.getElementById('snippetEditor').hidden = false;
  document.getElementById('snipText').focus();
}

function closeSnippetEditor() {
  editingSnippetId = null;
  document.getElementById('snippetEditor').hidden = true;
}

function saveSnippet() {
  var text = document.getElementById('snipText').value.trim();
  if (!text) { document.getElementById('snipText').focus(); return; }
  var label = document.getElementById('snipLabel').value.trim();
  var category = document.getElementById('snipCategory').value.trim();

  if (editingSnippetId) {
    var existing = null;
    for (var i = 0; i < snippets.length; i++) {
      if (snippets[i].id === editingSnippetId) { existing = snippets[i]; break; }
    }
    if (existing) { existing.text = text; existing.label = label; existing.category = category; }
  } else {
    snippets.unshift({ id: newSnippetId(), text: text, label: label, category: category });
  }
  persistSnippets(function () {
    closeSnippetEditor();
    renderSnippets(currentCheatFilter());
  });
}

function newSnippetId() {
  return 'snip_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

// Normalize an incoming snippet (from an imported file) into our shape.
function normalizeSnippet(raw) {
  if (!raw) return null;
  // Support {text,label,category} and the built-in pack shape {p,d,category}.
  var text = raw.text != null ? raw.text : raw.p;
  if (text == null || String(text).trim() === '') return null;
  return {
    id: newSnippetId(),
    text: String(text),
    label: String(raw.label != null ? raw.label : (raw.d != null ? raw.d : '')),
    category: String(raw.category != null ? raw.category : '')
  };
}

function importSnippets(file) {
  var reader = new FileReader();
  reader.onload = function () {
    var data;
    try { data = JSON.parse(reader.result); }
    catch (e) { showCheatMsg('Invalid JSON file.', true); return; }

    // Accept: raw array, {snippets:[...]}, or a pack with {items:[...]}.
    var incoming = Array.isArray(data) ? data
      : (Array.isArray(data.snippets) ? data.snippets
        : (Array.isArray(data.items) ? data.items : null));

    if (!incoming) { showCheatMsg('No snippets found in that file.', true); return; }

    // Dedup against existing by text+label.
    var seen = {};
    snippets.forEach(function (s) { seen[(s.text || '') + ' ' + (s.label || '')] = true; });

    var added = 0;
    incoming.forEach(function (raw) {
      var norm = normalizeSnippet(raw);
      if (!norm) return;
      var key = norm.text + ' ' + norm.label;
      if (seen[key]) return;
      seen[key] = true;
      snippets.push(norm);
      added++;
    });

    persistSnippets(function () {
      renderSnippets(currentCheatFilter());
      showCheatMsg('Imported ' + added + ' snippet(s).', false);
    });
  };
  reader.onerror = function () { showCheatMsg('Could not read the file.', true); };
  reader.readAsText(file);
}

function exportSnippets() {
  var data = {
    app: 'QuickNote',
    type: 'cheatsheet',
    name: 'My snippets',
    version: 1,
    exportedAt: new Date().toISOString(),
    snippets: snippets.map(function (s) {
      return { text: s.text, label: s.label || '', category: s.category || '' };
    })
  };
  downloadJson(data, 'quicknote-cheatsheet-' + new Date().toISOString().slice(0, 10) + '.json');
  showCheatMsg('Exported ' + snippets.length + ' snippet(s).', false);
}

function showCheatMsg(text, isError) {
  var el = document.getElementById('cheatMsg');
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle('error', !!isError);
  setTimeout(function () { el.hidden = true; }, 2500);
}

// ---------------------------------------------------------------------------
// Backup: export / import
// ---------------------------------------------------------------------------
function downloadJson(data, filename) {
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportNotes() {
  chrome.storage.local.get(['notes', 'global', 'snippets'], function (result) {
    var data = {
      app: 'QuickNote',
      version: 3,
      exportedAt: new Date().toISOString(),
      notes: result.notes || {},
      global: result.global || [],
      snippets: result.snippets || []
    };
    downloadJson(data, 'quicknote-backup-' + new Date().toISOString().slice(0, 10) + '.json');
    showBackupMsg('Exported successfully.', false);
  });
}

function importNotes(file) {
  var reader = new FileReader();
  reader.onload = function () {
    var data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      showBackupMsg('Invalid JSON file.', true);
      return;
    }
    if (!data || (typeof data.notes !== 'object' && !Array.isArray(data.global))) {
      showBackupMsg('This does not look like a QuickNote backup.', true);
      return;
    }

    chrome.storage.local.get(['notes', 'global'], function (result) {
      var buckets = result.notes || {};
      var global = result.global || [];
      var added = 0;

      // Merge page notes, skipping duplicate IDs. Every incoming note is
      // sanitized so only well-formed, bounded values reach storage.
      var incoming = data.notes || {};
      Object.keys(incoming).forEach(function (url) {
        if (!Array.isArray(incoming[url])) return;
        if (!buckets[url]) buckets[url] = [];
        var existingIds = {};
        buckets[url].forEach(function (n) { existingIds[n.id] = true; });
        incoming[url].forEach(function (raw) {
          var n = sanitizeNote(raw);
          if (n && !existingIds[n.id]) { buckets[url].push(n); existingIds[n.id] = true; added++; }
        });
      });

      // Merge global notes.
      var globalIds = {};
      global.forEach(function (n) { globalIds[n.id] = true; });
      (Array.isArray(data.global) ? data.global : []).forEach(function (raw) {
        var n = sanitizeNote(raw);
        if (n) { n.scope = 'global'; if (!globalIds[n.id]) { global.push(n); globalIds[n.id] = true; added++; } }
      });

      // Merge snippets if the backup carries them (dedup by text+label).
      var existingSnips = Array.isArray(result.snippets) ? result.snippets : [];
      var snipSeen = {};
      existingSnips.forEach(function (s) { snipSeen[(s.text || '') + ' ' + (s.label || '')] = true; });
      (Array.isArray(data.snippets) ? data.snippets : []).forEach(function (raw) {
        var norm = normalizeSnippet(raw);
        if (!norm) return;
        var key = norm.text + ' ' + norm.label;
        if (snipSeen[key]) return;
        snipSeen[key] = true;
        existingSnips.push(norm);
        added++;
      });

      chrome.storage.local.set({ notes: buckets, global: global, snippets: existingSnips }, function () {
        showBackupMsg('Imported ' + added + ' item(s).', false);
        snippets = existingSnips;
        refreshNotes();
        renderStats();
        renderSnippets(currentCheatFilter());
      });
    });
  };
  reader.onerror = function () { showBackupMsg('Could not read the file.', true); };
  reader.readAsText(file);
}

function showBackupMsg(text, isError) {
  var el = document.getElementById('backupMsg');
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle('error', !!isError);
}

// ---------------------------------------------------------------------------
// Tabs + wiring
// ---------------------------------------------------------------------------
function initTabs() {
  var tabs = document.querySelectorAll('.tab');
  tabs.forEach(function (tab) {
    tab.onclick = function () {
      tabs.forEach(function (t) { t.classList.remove('tab-active'); });
      tab.classList.add('tab-active');
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('panel-active'); });
      var panel = document.getElementById('panel-' + tab.getAttribute('data-tab'));
      if (panel) panel.classList.add('panel-active');
    };
  });
}

document.addEventListener('DOMContentLoaded', function () {
  initTabs();
  renderStats();
  refreshNotes();
  loadSnippets(function () { renderSnippets(''); });

  document.getElementById('noteSearch').addEventListener('input', function (e) {
    renderNotesList(e.target.value);
  });

  // Snippets (cheat sheet) wiring
  document.getElementById('cheatSearch').addEventListener('input', function (e) {
    renderSnippets(e.target.value);
  });
  document.getElementById('addSnippetBtn').addEventListener('click', function () {
    openSnippetEditor(null);
  });
  document.getElementById('snipSave').addEventListener('click', saveSnippet);
  document.getElementById('snipCancel').addEventListener('click', closeSnippetEditor);
  document.getElementById('exportCheatBtn').addEventListener('click', exportSnippets);
  document.getElementById('importCheatFile').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) importSnippets(e.target.files[0]);
    e.target.value = '';
  });

  // Backup wiring
  document.getElementById('exportBtn').addEventListener('click', exportNotes);
  document.getElementById('importFile').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) importNotes(e.target.files[0]);
    e.target.value = '';
  });
});
