// QuickNote - Background Service Worker
//
// Storage model (chrome.storage.local):
//   notes  : { [normalizedUrl]: Note[] }   -> page-scoped notes
//   global : Note[]                          -> notes shown on EVERY page
//
// A page's rendered notes = notes[url] + global. This lets the extension
// double as an always-available cheat sheet (e.g. SQLi payloads) that does
// not disappear when a site's URL/subdomain changes between visits.

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'https://chrome.google.com',
  'https://chromewebstore.google.com',
  'edge://',
  'about:',
  'file://'
];

chrome.runtime.onInstalled.addListener(function () {
  // Remove any stale items first so reloads/updates never leave duplicates.
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: 'add-quicknote',
      title: 'Add QuickNote here',
      contexts: ['page', 'selection']
    });
  });

  chrome.storage.local.get(['notes', 'global'], function (result) {
    if (!result.notes) chrome.storage.local.set({ notes: {} });
    if (!result.global) chrome.storage.local.set({ global: [] });
  });
});

// --- Context menu -> ask content script to create a note ---------------------

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId !== 'add-quicknote') return;

  if (isRestrictedUrl(tab.url)) {
    flashBadge('!', '#ef4444');
    return;
  }

  createNoteInTab(tab.id, {
    action: 'createNote',
    scope: 'page',
    selectedText: info.selectionText || ''
  });
});

// Sends a createNote message to the tab. If the content script isn't there yet
// (e.g. the tab was open before the extension was reloaded/installed), inject
// it on the fly, then send the message. This is what lets notes work without a
// manual page refresh. Injection only happens when messaging fails, so pages
// that already have the content script never get a duplicate.
function createNoteInTab(tabId, payload) {
  chrome.tabs.sendMessage(tabId, payload, function () {
    if (!chrome.runtime.lastError) return; // delivered fine
    chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ['content.css'] }, function () {
      chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] }, function () {
        if (chrome.runtime.lastError) { flashBadge('!', '#f59e0b'); return; }
        // Give the freshly injected script a moment to register its listener.
        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, payload, function () {
            if (chrome.runtime.lastError) flashBadge('!', '#f59e0b');
          });
        }, 60);
      });
    });
  });
}

function flashBadge(text, color) {
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: color });
  setTimeout(function () {
    chrome.action.setBadgeText({ text: '' });
  }, 3000);
}

function isRestrictedUrl(url) {
  if (!url) return true;
  for (var i = 0; i < RESTRICTED_PREFIXES.length; i++) {
    if (url.indexOf(RESTRICTED_PREFIXES[i]) === 0) return true;
  }
  return false;
}

// --- Message handlers --------------------------------------------------------

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  switch (request.action) {
    case 'getNotes':
      handleGetNotes(request, sendResponse);
      return true;
    case 'saveNote':
      handleSaveNote(request, sendResponse);
      return true;
    case 'updateNote':
      handleUpdateNote(request, sendResponse);
      return true;
    case 'deleteNote':
      handleDeleteNote(request, sendResponse);
      return true;
    case 'changeScope':
      handleChangeScope(request, sendResponse);
      return true;
    case 'getStats':
      handleGetStats(sendResponse);
      return true;
    default:
      return false;
  }
});

function bucketKey(note, url) {
  // Returns the storage bucket a note lives in.
  return note && note.scope === 'global' ? '__global__' : url;
}

function handleGetNotes(request, sendResponse) {
  var url = normalizeUrl(request.url);
  chrome.storage.local.get(['notes', 'global'], function (result) {
    var notes = result.notes || {};
    var global = result.global || [];
    var pageNotes = notes[url] || [];
    // Global notes render everywhere; tag them so the client knows.
    sendResponse({ notes: pageNotes.concat(global) });
  });
}

function handleSaveNote(request, sendResponse) {
  var note = request.note;
  chrome.storage.local.get(['notes', 'global'], function (result) {
    var notes = result.notes || {};
    var global = result.global || [];

    if (note.scope === 'global') {
      global.push(note);
      chrome.storage.local.set({ global: global }, function () {
        sendResponse({ success: true });
      });
    } else {
      var url = normalizeUrl(request.url);
      if (!notes[url]) notes[url] = [];
      notes[url].push(note);
      chrome.storage.local.set({ notes: notes }, function () {
        sendResponse({ success: true });
      });
    }
  });
}

function handleUpdateNote(request, sendResponse) {
  var note = request.note;
  chrome.storage.local.get(['notes', 'global'], function (result) {
    var notes = result.notes || {};
    var global = result.global || [];

    if (note.scope === 'global') {
      global = replaceById(global, note);
      chrome.storage.local.set({ global: global }, function () {
        sendResponse({ success: true });
      });
      return;
    }

    var url = normalizeUrl(request.url);
    if (notes[url]) {
      notes[url] = replaceById(notes[url], note);
      chrome.storage.local.set({ notes: notes }, function () {
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false });
    }
  });
}

function handleDeleteNote(request, sendResponse) {
  chrome.storage.local.get(['notes', 'global'], function (result) {
    var notes = result.notes || {};
    var global = result.global || [];
    var url = normalizeUrl(request.url);

    if (request.scope === 'global') {
      global = global.filter(function (n) { return n.id !== request.noteId; });
      chrome.storage.local.set({ global: global }, function () {
        sendResponse({ success: true });
      });
      return;
    }

    if (notes[url]) {
      notes[url] = notes[url].filter(function (n) { return n.id !== request.noteId; });
      if (notes[url].length === 0) delete notes[url];
      chrome.storage.local.set({ notes: notes }, function () {
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false });
    }
  });
}

// Moves a note between page-scope and global-scope atomically. request.note
// already carries its NEW scope; we remove it from both possible locations by
// id, then insert it into the correct bucket.
function handleChangeScope(request, sendResponse) {
  var note = request.note;
  var url = normalizeUrl(request.url);
  chrome.storage.local.get(['notes', 'global'], function (result) {
    var notes = result.notes || {};
    var global = result.global || [];

    // Remove from the page bucket for this URL, if present.
    if (notes[url]) {
      notes[url] = notes[url].filter(function (n) { return n.id !== note.id; });
      if (notes[url].length === 0) delete notes[url];
    }
    // Remove from global, if present.
    global = global.filter(function (n) { return n.id !== note.id; });

    // Insert into the target bucket.
    if (note.scope === 'global') {
      global.push(note);
    } else {
      if (!notes[url]) notes[url] = [];
      notes[url].push(note);
    }

    chrome.storage.local.set({ notes: notes, global: global }, function () {
      sendResponse({ success: true });
    });
  });
}

function handleGetStats(sendResponse) {
  chrome.storage.local.get(['notes', 'global'], function (result) {
    var notes = result.notes || {};
    var global = result.global || [];
    var totalNotes = global.length;
    var totalPages = 0;
    for (var key in notes) {
      if (Object.prototype.hasOwnProperty.call(notes, key)) {
        totalNotes += notes[key].length;
        totalPages++;
      }
    }
    sendResponse({
      totalNotes: totalNotes,
      totalPages: totalPages,
      globalNotes: global.length
    });
  });
}

// --- Helpers -----------------------------------------------------------------

function replaceById(arr, note) {
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id === note.id) {
      arr[i] = note;
      break;
    }
  }
  return arr;
}

function normalizeUrl(url) {
  try {
    var parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch (e) {
    return url;
  }
}
