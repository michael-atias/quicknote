# Privacy Policy — QuickNote

_Last updated: 2026-07-22_

QuickNote is designed to be private by default. In short: **your data never leaves your browser.**

## What QuickNote stores

- The notes you create (their text, position, size, and color)
- Your cheat-sheet snippets
- Whether a note is page-specific or global

All of this is saved locally in your browser using the standard `chrome.storage.local` API. It stays on your device.

## What QuickNote does **not** do

- It does **not** send your notes, snippets, or browsing data anywhere.
- It contains **no** network code — no servers, no analytics, no tracking, no telemetry, no ads.
- It does **not** collect personal information.
- It does **not** share or sell any data (there is nothing to share).

You can verify this: the source contains no `fetch`, `XMLHttpRequest`, `WebSocket`, or remote script references of any kind.

## Permissions and why they're used

| Permission | Purpose |
|---|---|
| `storage` | Save your notes and snippets locally on your device |
| `contextMenus` | Add the right-click "Add QuickNote here" item |
| `activeTab` | Interact with the current tab to place and reveal notes |
| `scripting` | Inject the note script into the current tab on demand, so notes work without a page refresh |
| Content script on all sites | Draw your notes on the pages where you place them, and show global notes everywhere |

The content script runs on pages so it can display your notes; it only ever reads/writes your own QuickNote data and never transmits anything.

## Your data, your control

- **Export** your notes and snippets to a JSON file at any time (Backup tab).
- **Import** them back, or move them to another machine.
- **Delete** a note, or uninstall the extension to remove all stored data.

## Contact

Questions? Open an issue on the project's repository.
