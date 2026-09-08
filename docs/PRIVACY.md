# Privacy Policy

**GitHub Pixel Diff** — last updated 8 September 2026.

## What the extension collects

Nothing. It has no analytics, no telemetry, no crash reporting, and no server
of its own. Nothing about you or the pages you visit is sent anywhere.

## What it stores

Two kinds of settings, and only settings:

- **Your preferences** — the diff threshold, whether the outline is drawn,
  which frame was shown last, and whether the before / after / diff switcher
  is visible. They are kept by the browser's own extension storage. If you are
  signed into the browser and have extension sync turned on, the browser may
  sync them across your devices; that is the browser's mechanism, not ours.
- **The permission you grant** — held by the browser itself, and revocable at
  any time from the browser's extension settings.

No image, file name, repository name, URL, or account information is stored.

## What it accesses

The extension runs on one address: `https://viewscreen.githubusercontent.com/diff/img`,
the frame GitHub uses to display image diffs. Inside that frame it reads the
two images GitHub has already loaded and compares them in your browser. It does
not run on `github.com` pages, does not read your repositories, and does not
touch any other site.

The comparison happens entirely on your machine. The images never leave it.

## Third parties

None. No data is shared, sold, or transferred to anyone, and no code is loaded
from a remote server — everything the extension runs ships inside the package.

## Contact

Questions and reports: <https://github.com/Nemo-Illusionist/gh-pixel-diff/issues>
