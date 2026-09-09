# Brand assets

Source artwork lives here. The files Next.js actually serves as icons and social
cards live in `apps/marketing/app/` under its file conventions — Next generates the
`<link>` and `<meta>` tags from the filename, so there is nothing to wire up by hand
and nothing to keep in sync.

| Purpose | Put the file at | Size |
|---|---|---|
| Favicon / tab icon | `app/icon.png` | 512×512 (Next downsizes) |
| iOS home screen | `app/apple-icon.png` | 180×180 |
| Social card (all routes) | `app/opengraph-image.png` | 1200×630 |

Anything in this folder is a SOURCE file — full-resolution masters, variants, the
original vector. Nothing here is referenced by the app; it exists so the next person
does not have to ask where the logo came from.

## The favicon must be the MARK ONLY

Not the lockup. At 32px the wordmark is an unreadable smudge and the whole icon reads
as a blue blur, which is worse than no icon because a tab is identified by its shape.
Export the arrow-and-box glyph alone, cropped tight, with no baked-in margin — the
browser adds its own.
