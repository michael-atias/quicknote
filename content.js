// QuickNote - Content Script
//
// Renders sticky notes on the page. Notes are either page-scoped (tied to the
// current URL) or global (rendered on every page). Global notes make the
// extension usable as an always-available cheat sheet.

(function () {
  'use strict';

  // Guard against loading twice (manifest content_scripts + on-demand injection
  // could otherwise both run, duplicating listeners and creating several notes
  // per action). If we're already loaded, do nothing.
  if (window.__quicknoteLoaded) return;
  window.__quicknoteLoaded = true;

  var notes = [];
  var lastClickX = 100;
  var lastClickY = 100;
  var lastKnownUrl = location.href;

  // Notes can be any color. We store a hex string and always validate it before
  // applying, so untrusted data (e.g. imported JSON) can never inject CSS.
  var LEGACY_COLORS = {
    yellow: '#fef9c3', blue: '#dbeafe', green: '#dcfce7', pink: '#fce7f3'
  };
  var DEFAULT_COLOR = '#fef9c3';

  // Returns a safe #rrggbb string from any stored value.
  function toHex(value) {
    if (typeof value === 'string') {
      if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
      if (LEGACY_COLORS[value]) return LEGACY_COLORS[value];
    }
    return DEFAULT_COLOR;
  }

  // Pick readable text color (dark or light) for a given background hex.
  function contrastText(hex) {
    var r = parseInt(hex.substr(1, 2), 16);
    var g = parseInt(hex.substr(3, 2), 16);
    var b = parseInt(hex.substr(5, 2), 16);
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#1f2937' : '#f9fafb';
  }

  // Apply a color to a note's card. Sets a --qn-fg custom property that the
  // header text, icons, drag label, and footer all inherit, so every control
  // stays readable on any background (light or dark).
  function applyNoteColor(card, textarea, footer, value) {
    var hex = toHex(value);
    var txt = contrastText(hex);
    var isDark = txt !== '#1f2937';
    card.style.background = hex;
    card.style.border = '1px solid rgba(0, 0, 0, 0.15)';
    card.style.setProperty('--qn-fg', txt);
    if (textarea) textarea.style.color = txt;
    var header = card.querySelector('.quicknote-header');
    if (header) header.style.background = isDark ? 'rgba(0, 0, 0, 0.22)' : 'rgba(255, 255, 255, 0.4)';
  }

  // --- SPA / "invisible" navigation handling ---------------------------------
  // Busy pages mutate the DOM constantly, so we must NOT reload notes on every
  // mutation. We debounce and only act when the URL actually changed.
  var urlCheckTimer = null;
  var observer = new MutationObserver(function () {
    if (urlCheckTimer) return; // already scheduled
    urlCheckTimer = setTimeout(function () {
      urlCheckTimer = null;
      if (location.href !== lastKnownUrl) {
        lastKnownUrl = location.href;
        clearRenderedNotes();
        loadNotes();
      }
    }, 250);
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Also catch history API navigations directly (more reliable than mutations).
  window.addEventListener('popstate', handleUrlMaybeChanged);
  window.addEventListener('hashchange', handleUrlMaybeChanged);

  function handleUrlMaybeChanged() {
    if (location.href !== lastKnownUrl) {
      lastKnownUrl = location.href;
      clearRenderedNotes();
      loadNotes();
    }
  }

  function clearRenderedNotes() {
    var existing = document.querySelectorAll('.quicknote-container');
    existing.forEach(function (el) {
      if (el.__quicknoteCleanup) el.__quicknoteCleanup();
      el.remove();
    });
  }

  // Track right-click position so new notes appear where the user clicked.
  document.addEventListener('contextmenu', function (e) {
    lastClickX = e.pageX;
    lastClickY = e.pageY;
  });

  loadNotes();

  // --- Live sync across tabs --------------------------------------------------
  // When notes change in storage (edited/deleted/added in another tab),
  // reconcile the page without a refresh. Text and color of a note being
  // actively edited in THIS tab are left alone (guarded by focus) so we never
  // clobber what the user is typing.
  var reconcileTimer = null;
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (!changes.notes && !changes.global) return;
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcile, 150);
  });

  function reconcile() {
    chrome.runtime.sendMessage({ action: 'getNotes', url: window.location.href }, function (response) {
      if (chrome.runtime.lastError || !response || !response.notes) return;
      var fresh = response.notes;
      var freshById = {};
      fresh.forEach(function (n) { freshById[n.id] = true; });

      // Remove notes deleted in another tab.
      document.querySelectorAll('.quicknote-container').forEach(function (el) {
        var id = el.getAttribute('data-note-id');
        if (!freshById[id]) {
          if (el.__quicknoteCleanup) el.__quicknoteCleanup();
          el.remove();
          notes = notes.filter(function (n) { return n.id !== id; });
        }
      });

      // Add notes created elsewhere; update notes changed elsewhere.
      fresh.forEach(function (n) {
        var el = document.querySelector('[data-note-id="' + cssEscape(n.id) + '"]');
        if (!el) {
          notes.push(n);
          renderNote(n);
          return;
        }
        var obj = el.__quicknoteNote;
        if (!obj) return;
        var textarea = el.querySelector('.quicknote-content');

        // Only hold back a sync while the user is ACTIVELY typing in this note
        // in this tab (last keystroke < 1.5s ago). Merely having it focused no
        // longer blocks updates, so global notes keep syncing across tabs.
        var typingHere = el.__quicknoteLastEdit && (Date.now() - el.__quicknoteLastEdit < 1500);

        if (textarea && !typingHere && obj.content !== n.content) {
          var wasFocused = document.activeElement === textarea;
          textarea.value = n.content;
          obj.content = n.content;
          if (wasFocused) {
            // Keep the caret at the end so the incoming text isn't disruptive.
            try { textarea.setSelectionRange(n.content.length, n.content.length); } catch (e) { /* no-op */ }
          }
        }
        // Sync color.
        if (obj.color !== n.color) {
          obj.color = n.color;
          var card = el.querySelector('.quicknote-card');
          var footer = el.querySelector('.quicknote-footer');
          var pick = el.querySelector('.quicknote-colorpick');
          applyNoteColor(card, textarea, footer, n.color);
          if (pick) pick.value = toHex(n.color);
        }
      });
    });
  }

  // --- Messages from background / popup --------------------------------------
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === 'createNote') {
      createNote(lastClickX, lastClickY, request.selectedText || '', request.scope || 'page');
      sendResponse({ ok: true }); // reply so the sender knows we're present
    } else if (request.action === 'revealNote') {
      revealNote(request.noteId);
      sendResponse({ ok: true });
    } else if (request.action === 'ping') {
      sendResponse({ ok: true });
    }
    return false;
  });

  function loadNotes() {
    chrome.runtime.sendMessage(
      { action: 'getNotes', url: window.location.href },
      function (response) {
        if (chrome.runtime.lastError) return;
        if (response && response.notes) {
          notes = response.notes;
          for (var i = 0; i < notes.length; i++) {
            renderNote(notes[i]);
          }
        }
      }
    );
  }

  // --- Confirm dialog ---------------------------------------------------------
  function showConfirmDialog(message, onConfirm, onCancel) {
    var overlay = document.createElement('div');
    overlay.className = 'quicknote-confirm-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'quicknote-confirm-dialog';

    var icon = document.createElement('div');
    icon.className = 'quicknote-confirm-icon';
    icon.textContent = '🗑️';

    var msg = document.createElement('div');
    msg.className = 'quicknote-confirm-message';
    msg.textContent = message; // textContent avoids HTML injection

    var buttons = document.createElement('div');
    buttons.className = 'quicknote-confirm-buttons';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'quicknote-confirm-cancel';
    cancelBtn.textContent = 'Cancel';

    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'quicknote-confirm-delete';
    deleteBtn.textContent = 'Delete';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(deleteBtn);
    dialog.appendChild(icon);
    dialog.appendChild(msg);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    cancelBtn.focus();

    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    }

    cancelBtn.onclick = function () { cleanup(); if (onCancel) onCancel(); };
    deleteBtn.onclick = function () { cleanup(); if (onConfirm) onConfirm(); };
    overlay.onclick = function (e) {
      if (e.target === overlay) { cleanup(); if (onCancel) onCancel(); }
    };

    function escHandler(e) {
      if (e.key === 'Escape') { cleanup(); if (onCancel) onCancel(); }
    }
    document.addEventListener('keydown', escHandler);
  }

  // --- Note rendering ---------------------------------------------------------
  function renderNote(note) {
    var isGlobal = note.scope === 'global';

    var container = document.createElement('div');
    container.className = 'quicknote-container';
    container.setAttribute('data-note-id', note.id);
    container.style.left = note.x + 'px';
    container.style.top = note.y + 'px';
    container.style.position = 'absolute';
    container.style.zIndex = '2147483646';

    var pin = document.createElement('div');
    pin.className = 'quicknote-pin' + (isGlobal ? ' quicknote-pin-global' : '');
    pin.textContent = isGlobal ? '🌐' : '📝';
    pin.title = isGlobal
      ? 'Global note — click to view, drag to move'
      : 'Click to view, drag to move';

    var card = document.createElement('div');
    card.className = 'quicknote-card';
    card.style.display = 'none';
    card.style.width = (note.width || 260) + 'px';
    card.style.height = (note.height || 190) + 'px';

    // Header (built with DOM to avoid injecting note data as HTML).
    var header = document.createElement('div');
    header.className = 'quicknote-header';

    var dragArea = document.createElement('div');
    dragArea.className = 'quicknote-drag-area';
    dragArea.textContent = isGlobal ? '🌐 Global · drag' : 'Drag here';

    // Single color picker — choose any color.
    var colorPick = document.createElement('input');
    colorPick.type = 'color';
    colorPick.className = 'quicknote-color quicknote-colorpick';
    colorPick.value = toHex(note.color);
    colorPick.title = 'Pick note color';

    var scopeBtn = document.createElement('button');
    scopeBtn.className = 'quicknote-scope' + (isGlobal ? ' quicknote-scope-active' : '');
    scopeBtn.title = isGlobal
      ? 'Global note (shows on every page) — click to make it page-only'
      : 'Pin to all pages (make this a global note)';
    scopeBtn.textContent = '📌';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'quicknote-copy';
    copyBtn.title = 'Copy note text';
    copyBtn.textContent = '⧉';

    var monoBtn = document.createElement('button');
    monoBtn.className = 'quicknote-mono';
    monoBtn.title = 'Toggle code/monospace';
    monoBtn.textContent = '</>';

    var minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'quicknote-minimize';
    minimizeBtn.title = 'Minimize';
    minimizeBtn.textContent = '−';

    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'quicknote-delete';
    deleteBtn.title = 'Delete';
    deleteBtn.textContent = '×';

    header.appendChild(dragArea);
    header.appendChild(colorPick);
    header.appendChild(scopeBtn);
    header.appendChild(copyBtn);
    header.appendChild(monoBtn);
    header.appendChild(minimizeBtn);
    header.appendChild(deleteBtn);

    var textarea = document.createElement('textarea');
    textarea.className = 'quicknote-content' + (note.mono ? ' quicknote-mono-on' : '');
    textarea.placeholder = 'Write your note...';
    textarea.value = note.content || '';
    textarea.spellcheck = false;

    var footer = document.createElement('div');
    footer.className = 'quicknote-footer';
    footer.textContent = (isGlobal ? 'Global · ' : '') + formatDate(note.createdAt);

    var resizer = document.createElement('div');
    resizer.className = 'quicknote-resizer';

    card.appendChild(header);
    card.appendChild(textarea);
    card.appendChild(footer);
    card.appendChild(resizer);

    container.appendChild(pin);
    container.appendChild(card);

    // Apply the note's color now that card/textarea/footer exist.
    applyNoteColor(card, textarea, footer, note.color);

    // Keep a reference to the note object on the element so live cross-tab sync
    // can update the same note that drag/edit handlers write to.
    container.__quicknoteNote = note;

    // === Dragging / resizing state ===
    var isDraggingPin = false;
    var isDraggingCard = false;
    var isResizing = false;
    var pinStartX = 0, pinStartY = 0, pinOffsetX = 0, pinOffsetY = 0;
    var cardOffsetX = 0, cardOffsetY = 0;

    pin.onmousedown = function (e) {
      if (e.button !== 0) return;
      isDraggingPin = true;
      pinStartX = e.clientX;
      pinStartY = e.clientY;
      pinOffsetX = e.clientX - container.offsetLeft + window.scrollX;
      pinOffsetY = e.clientY - container.offsetTop + window.scrollY;
      e.preventDefault();
    };

    pin.onclick = function (e) {
      var moved = Math.abs(e.clientX - pinStartX) > 5 || Math.abs(e.clientY - pinStartY) > 5;
      if (!moved) {
        pin.style.display = 'none';
        card.style.display = 'flex';
      }
    };

    header.onmousedown = function (e) {
      if (e.target.tagName === 'BUTTON' || e.target.className.indexOf('quicknote-color') !== -1) return;
      isDraggingCard = true;
      cardOffsetX = e.clientX - container.offsetLeft + window.scrollX;
      cardOffsetY = e.clientY - container.offsetTop + window.scrollY;
      container.style.zIndex = '2147483647';
      e.preventDefault();
    };

    resizer.onmousedown = function (e) {
      isResizing = true;
      e.preventDefault();
      e.stopPropagation();
    };

    function onMouseMove(e) {
      if (isDraggingPin) {
        container.style.left = Math.max(0, e.clientX - pinOffsetX + window.scrollX) + 'px';
        container.style.top = Math.max(0, e.clientY - pinOffsetY + window.scrollY) + 'px';
      } else if (isDraggingCard) {
        container.style.left = Math.max(0, e.clientX - cardOffsetX + window.scrollX) + 'px';
        container.style.top = Math.max(0, e.clientY - cardOffsetY + window.scrollY) + 'px';
      } else if (isResizing) {
        var newWidth = e.clientX - container.offsetLeft + window.scrollX;
        var newHeight = e.clientY - container.offsetTop + window.scrollY;
        if (newWidth > 224) { card.style.width = newWidth + 'px'; note.width = newWidth; }
        if (newHeight > 110) { card.style.height = newHeight + 'px'; note.height = newHeight; }
      }
    }

    function onMouseUp() {
      if (isDraggingPin || isDraggingCard || isResizing) {
        note.x = parseInt(container.style.left, 10) || 0;
        note.y = parseInt(container.style.top, 10) || 0;
        updateNote(note);
        container.style.zIndex = '2147483646';
      }
      isDraggingPin = false;
      isDraggingCard = false;
      isResizing = false;
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Store a cleanup fn so listeners are removed when the note is removed for
    // ANY reason (delete, URL change, etc.) — fixes the listener leak.
    container.__quicknoteCleanup = function () {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    minimizeBtn.onclick = function (e) {
      e.stopPropagation();
      card.style.display = 'none';
      pin.style.display = 'flex';
    };

    deleteBtn.onclick = function (e) {
      e.stopPropagation();
      showConfirmDialog('Delete this note?', function () {
        container.__quicknoteCleanup();
        deleteNote(note);
        container.remove();
      });
    };

    copyBtn.onclick = function (e) {
      e.stopPropagation();
      copyText(textarea.value, copyBtn);
    };

    // Pin toggle: move the note between page-scope and global-scope.
    scopeBtn.onclick = function (e) {
      e.stopPropagation();
      note.scope = note.scope === 'global' ? 'page' : 'global';
      var nowGlobal = note.scope === 'global';
      scopeBtn.classList.toggle('quicknote-scope-active', nowGlobal);
      scopeBtn.title = nowGlobal
        ? 'Global note (shows on every page) — click to make it page-only'
        : 'Pin to all pages (make this a global note)';
      pin.textContent = nowGlobal ? '🌐' : '📝';
      pin.classList.toggle('quicknote-pin-global', nowGlobal);
      dragArea.textContent = nowGlobal ? '🌐 Global · drag' : 'Drag here';
      footer.textContent = (nowGlobal ? 'Global · ' : '') + formatDate(note.createdAt);
      note.updatedAt = Date.now();
      chrome.runtime.sendMessage({
        action: 'changeScope',
        url: window.location.href,
        note: note
      });
    };

    monoBtn.onclick = function (e) {
      e.stopPropagation();
      note.mono = !note.mono;
      textarea.classList.toggle('quicknote-mono-on', note.mono);
      monoBtn.classList.toggle('quicknote-mono-active', note.mono);
      updateNote(note);
    };
    if (note.mono) monoBtn.classList.add('quicknote-mono-active');

    colorPick.onclick = function (e) { e.stopPropagation(); };
    colorPick.oninput = function () {
      note.color = colorPick.value;
      applyNoteColor(card, textarea, footer, note.color);
      note.updatedAt = Date.now();
      updateNote(note);
    };

    var saveTimeout;
    textarea.oninput = function () {
      container.__quicknoteLastEdit = Date.now(); // marks "actively typing here"
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(function () {
        note.content = textarea.value;
        note.updatedAt = Date.now();
        updateNote(note);
      }, 400);
    };

    container.onclick = function (e) { e.stopPropagation(); };

    document.body.appendChild(container);
  }

  function copyText(text, btn) {
    var done = function () {
      if (!btn) return;
      var prev = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('quicknote-copied');
      setTimeout(function () {
        btn.textContent = prev;
        btn.classList.remove('quicknote-copied');
      }, 1000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) { /* no-op */ }
    }
  }

  // Bring a note into view and flash it — used by the popup's notes manager.
  function revealNote(noteId) {
    var container = document.querySelector('[data-note-id="' + cssEscape(noteId) + '"]');
    if (!container) return;

    // If the pin sits outside the current viewport, pull it back in.
    var left = parseInt(container.style.left, 10) || 0;
    var top = parseInt(container.style.top, 10) || 0;
    var maxLeft = window.scrollX + window.innerWidth - 80;
    var maxTop = window.scrollY + window.innerHeight - 80;
    if (left > maxLeft || top > maxTop || left < window.scrollX || top < window.scrollY) {
      left = window.scrollX + 40;
      top = window.scrollY + 40;
      container.style.left = left + 'px';
      container.style.top = top + 'px';
      var noteObj = findNote(noteId);
      if (noteObj) { noteObj.x = left; noteObj.y = top; updateNote(noteObj); }
    }

    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var pin = container.querySelector('.quicknote-pin');
    var card = container.querySelector('.quicknote-card');
    if (pin) pin.style.display = 'none';
    if (card) card.style.display = 'flex';
    container.classList.add('quicknote-flash');
    setTimeout(function () { container.classList.remove('quicknote-flash'); }, 1500);
  }

  function findNote(id) {
    for (var i = 0; i < notes.length; i++) {
      if (notes[i].id === id) return notes[i];
    }
    return null;
  }

  function createNote(x, y, initialText, scope) {
    var note = {
      id: 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      content: initialText || '',
      x: x,
      y: y,
      width: 260,
      height: 190,
      color: scope === 'global' ? '#dbeafe' : '#fef9c3',
      scope: scope || 'page',
      mono: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    chrome.runtime.sendMessage(
      { action: 'saveNote', url: window.location.href, note: note },
      function (response) {
        if (chrome.runtime.lastError) return;
        if (response && response.success) {
          notes.push(note);
          renderNote(note);
          var container = document.querySelector('[data-note-id="' + cssEscape(note.id) + '"]');
          if (container) {
            container.classList.add('quicknote-appear');
            container.querySelector('.quicknote-pin').style.display = 'none';
            var card = container.querySelector('.quicknote-card');
            card.style.display = 'flex';
            card.querySelector('.quicknote-content').focus();
          }
        }
      }
    );
  }

  function updateNote(note) {
    chrome.runtime.sendMessage({
      action: 'updateNote',
      url: window.location.href,
      note: note
    });
  }

  function deleteNote(note) {
    chrome.runtime.sendMessage({
      action: 'deleteNote',
      url: window.location.href,
      noteId: note.id,
      scope: note.scope || 'page'
    });
    notes = notes.filter(function (n) { return n.id !== note.id; });
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function formatDate(timestamp) {
    return new Date(timestamp).toLocaleDateString();
  }
})();
