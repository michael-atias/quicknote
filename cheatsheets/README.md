# Cheat-sheet packs

Ready-made snippet packs you can import into QuickNote. Open the extension popup → **Cheat Sheet** tab → **Import**, and pick one of these `.json` files. Every snippet becomes a click-to-copy entry, grouped by category.

## Available packs

| File | What's inside |
|---|---|
| `sql-injection.json` | Common SQLi payloads (UNION, column count, DB version, blind, time-based) |
| `xss.json` | Cross-site scripting probes and filter bypasses |
| `command-injection.json` | OS command-injection separators and probes |
| `regex.json` | Regular-expression building blocks and ready patterns |
| `linux-commands.json` | Everyday Linux/bash terminal commands |
| `docker.json` | Common Docker CLI commands |
| `git-commands.json` | Everyday Git commands |
| `email-templates.json` | Reusable email/reply snippets (uses `{{placeholders}}`) |

> ⚠️ The security packs (`sql-injection`, `xss`, `command-injection`) are for **authorized testing and education only** — PortSwigger Web Security Academy, your own lab environments, or systems you have explicit permission to test.

**Tip:** snippets can contain `{{placeholders}}` — QuickNote will prompt you to fill them in when you copy. See `email-templates.json` for an example.

## File format

A pack is a JSON file with a `snippets` array. Each snippet has:

- `text` (required) — the string that gets copied
- `label` (optional) — a short description shown under the text
- `category` (optional) — groups snippets under a heading

```json
{
  "app": "QuickNote",
  "type": "cheatsheet",
  "name": "My Pack",
  "version": 1,
  "snippets": [
    { "category": "Basics", "label": "What it does", "text": "the thing to copy" },
    { "text": "a minimal snippet with no label or category" }
  ]
}
```

A bare JSON array of snippet objects also works.

## Make your own

Add snippets in the popup, then use **Export** in the Cheat Sheet tab to download them as a pack. Drop the file here and open a pull request to share it.
