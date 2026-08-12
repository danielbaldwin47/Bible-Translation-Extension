# Highlights are local-only

Highlights made in the inline talk reader are stored in
`chrome.storage.local` on this machine — deliberately not written to the
user's Church account annotations and not synced via `chrome.storage.sync`.
The Church site exposes no annotation API a content-script panel could safely
use, and sync storage quotas are far too small for highlight data. Consequence:
highlights don't follow the user across machines, and the site's own
annotations are never touched by the extension.
