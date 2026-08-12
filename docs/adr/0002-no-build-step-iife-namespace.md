# No build step: IIFEs on one `__BTX` global, classic service worker

The extension ships as plain HTML/CSS/JS loaded unpacked — no bundler, no
TypeScript, no ES modules. Every file is an IIFE attaching to the single
`__BTX` namespace; the service worker stays a *classic* worker (no
`"type": "module"`) so it can share code via `importScripts`; content scripts
are ordered by dependency in `manifest.json`. Chosen because the edit → reload
loop with zero tooling is worth more to a personal load-unpacked extension
than module ergonomics. Do not "modernize" this: switching to modules forces a
module worker, breaks `importScripts` sharing, and drags in a build step.
