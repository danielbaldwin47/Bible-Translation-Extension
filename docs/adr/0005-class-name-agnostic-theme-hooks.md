# Class-name-agnostic theme and DOM hooks

The Church site's CSS class names are build-hashed and change between deploys,
so the extension never selects on them. Theme mirroring reads resolved
computed styles, and DOM anchoring uses stable structural hooks (see
`src/content/theme.js`). This is why the theme code looks indirect — reading
colors and heights off elements instead of matching classes. Do not "simplify"
it to class selectors; they would break on the site's next deploy.
