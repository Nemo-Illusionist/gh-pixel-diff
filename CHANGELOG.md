# Changelog

Up to 0.9.0 this file was written by hand. From 0.10.0 on it is assembled by
release-please from commit subjects, which is why the style changes partway
down. The project follows [semantic versioning](https://semver.org/).

## [0.10.1](https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.10.0...v0.10.1) (2026-09-10)


### Documentation

* a privacy policy page on the site ([#30](https://github.com/Nemo-Illusionist/gh-pixel-diff/issues/30)) ([8745cf8](https://github.com/Nemo-Illusionist/gh-pixel-diff/commit/8745cf85a3704ef6999732022c64818d394b1967))

## [0.10.0](https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.9.0...v0.10.0) (2026-09-10)


### Features

* links to the Chrome Web Store, AMO and the standalone page ([#28](https://github.com/Nemo-Illusionist/gh-pixel-diff/issues/28)) ([6f36077](https://github.com/Nemo-Illusionist/gh-pixel-diff/commit/6f36077bb45a9a0ed03f67485d4394ce5fe7ac76))

## [0.9.0]

### Added

- **GitLab.** The mode now sits in GitLab's own row of image modes too, in merge
  requests on `gitlab.com`: the same crop to what changed, the same threshold,
  the same before / after / diff / 3-up. What differs is the shell around it —
  GitLab loads diffs as you scroll and re-renders the row of modes, so the
  button is re-added when it disappears; images live on the same domain, so the
  canvas is read without CORS, and the request keeps its cookies — without that
  images in a private project would not load at all.
- The worker and the drawing are now shared code (`content/worker-host.js`,
  `content/render.js`), not two copies: the GitHub frame, the GitLab page and
  the standalone page all use one.
- The live check runs against GitLab as well. It is not a formality: GitLab
  rewrote how it renders diffs, and only a real page tells you that.

- Each half of the standalone page now has a **Remove** button, and the result
  has **Start over**; the file name is shown with the image's size, since the
  thumbnail alone does not tell you what is being compared.
- A standalone page — <https://nemo-illusionist.github.io/gh-pixel-diff/> — where
  you drop two images of your own and get the same comparison: the same crop to
  what changed, the same threshold slider, the same before / after / diff / 3-up.
  It is a shell around the same code rather than a second copy of it: the
  comparison, the drawing, the worker and the panel's styles are taken straight
  out of `src/`, and the page's strings live in the same locale files. Nothing
  is uploaded — it is a static file on GitHub Pages.

- `npm run chrome:token` — issuing the Chrome Web Store refresh token in one
  run: it catches the code on a loopback port, exchanges it and writes the
  three secrets straight to the repository, so nothing passes through the
  terminal. The manual recipe in `docs/PUBLISHING.md` was also wrong — Google
  closed the `oob` redirect in 2022, and a freshly created client answers
  `invalid_request`.
- `npm run icons` also renders the 1400×560 promo image the Chrome listing
  asks for, next to the 440×280 tile. Both are opaque, as that store requires.

## [0.8.0]

### Added

- Publishing to the Chrome Web Store and to addons.mozilla.org happens on the
  release tag, next to the archives. Each store is switched on by a repository
  variable, so a fork never publishes in someone else's name; the one-time
  setup is written down in `docs/PUBLISHING.md`.
- A privacy policy — `docs/PRIVACY.md`. Both stores ask for one, and it says
  what the extension stores and what it does not.
- `npm run icons` — every icon size is rendered from a single
  `src/icons/icon.svg`, along with the 440×280 promo tile the Chrome listing
  asks for. The mark itself is redrawn: the changed pixels are large enough to
  survive at 16 px, and the grid is a multiple of eight so they land on whole
  pixels there.
- `npm run screenshots` — the screenshots for the README and for the store
  listings are now made from the live pull request by a script, in English, in
  the same container as the tests.

### Fixed

- The standalone page came out without a single caption in some browsers. It
  claimed `window.chrome` to hand the shared i18n code its source of strings,
  and that name belongs to the browser: where it is closed for writing, the
  assignment threw in strict mode, the script carrying the strings never
  finished, and every label silently rendered empty. The source now has a name
  of its own. A test reproduces the read-only `window.chrome` and fails on the
  old code.

### Changed

- The Firefox build is linted the way addons.mozilla.org will lint it: without
  `--self-hosted`, since the add-on is now submitted to the store.

## [0.7.1]

### Fixed

- The frame was pinned to the left edge of a long caption instead of sitting in
  the middle. The panel borrowed GitHub's own `shell` class, and that class sets
  `display: block`, which beat our flex layout — so centering never applied.
  The tests now load the extension's CSS before the page's own, the way a
  browser does, and catch this class of collision.

## [0.7.0]

### Changed

- Three frames side by side is now the fourth option of the before / after /
  diff switcher rather than its own entry in the native row of modes, and the
  chosen frame is remembered between images.

## [0.6.1]

### Fixed

- With a remembered mode, the page opened on Pixel Diff showing nothing until
  you switched away and back. The frame's height is set by the parent page, and
  only when GitHub's own mode changes — restoring our mode earlier left the
  window inside a 150-pixel strip and the frame squeezed to a couple of pixels.
  The restore now waits for the frame to grow.

## [0.6.0]

### Added

- A second mode in the native row — **3-up**: before, after and the difference
  side by side, all three in the same crop and scale, each fitted to a third of
  the width.

### Changed

- Playwright bumped to 1.63.0, in the package and in the image tag alike.

## [0.5.1]

### Changed

- `main` is protected: everything lands through a pull request with green
  checks, and a release is cut by tagging after the version bump is merged.
- Housekeeping from the code review: the height reserve lives in CSS only, the
  string keys are looked up by name, and the tests read the script list from the
  manifest instead of repeating it.

## [0.5.0]

### Fixed

- Moving the threshold slider while the images were still loading started a
  second worker and handed it buffers already given away — the panel showed
  `ArrayBuffer is already detached` and the new threshold was dropped.
- A worker that failed to start left the panel on "Comparing…" forever. It now
  greets the main thread before the images are handed over, so a failure falls
  back to computing in place with the images intact.
- A failed load is no longer remembered forever: a network blip used to lock the
  frame into the same error until another file was opened.
- Settings (threshold, outline, remembered mode) live in extension storage
  instead of the frame's own. In Safari the frame is third-party storage, which
  WebKit makes ephemeral — everything was lost on restart, and on iOS almost
  every time the tab came back.
- Safari 15.4–16.3 could not compare at all: `OffscreenCanvas` arrived in 16.4.
  There is a plain canvas fallback now.
- An image with no size reported `The source width is 0` from the canvas
  internals instead of a readable message.
- Zero changed pixels were shown as `<0.01% of the frame` instead of `0%`.
- The extension window now offers the access button even when the check itself
  failed; before that the user got an error message and no way forward.

### Changed

- One listener on the worker for its whole life instead of a pair per slider
  move.
- The caption announces itself to screen readers (`aria-live`), the frame
  switcher reports its state (`aria-pressed`), the canvas is no longer mute
  (`role="img"`).

## [0.4.0]

### Added

- A before / after / diff switcher under the frame — the two versions shown in
  the same scale and crop as the difference.
- A setting in the extension's window to hide that switcher; it is shown by
  default.

## [0.3.0]

### Added

- The chosen mode carries over to the next image in the pull request; switching
  back to a native mode stops that.
- SVG is rasterized at a sensible size — a vector with no intrinsic size is no
  longer compared as the 300×150 the browser makes up — and the caption reports
  the size used.

### Changed

- The comparison runs in a worker: the panel stays responsive on multi-megapixel
  screenshots, and both images live in the worker instead of the frame's memory.
- The full-frame canvas is reused between renders instead of being allocated
  again on every slider move.

## [0.2.3]

### Fixed

- No empty strip inside the border next to the frame in Safari: the canvas now
  carries the border itself and its aspect ratio is set explicitly, instead of
  being left to how the browser sizes a flex item.

## [0.2.2]

### Added

- The popup shows the installed version.
- `npm run install:macos` — builds, signs and installs the Safari extension in
  one step, without leaving a duplicate entry in Safari's list.

## [0.2.1]

### Added

- The red outline around the changed area in the full frame can be turned off
  from the caption; the choice is remembered.

## [0.2.0]

### Added

- Interface localization — English by default, Russian when the browser is set
  to Russian.
- "Report a problem" link in the extension popup, prefilled with the version
  and browser.
- An options page (the same panel as the popup) for browsers that show one.
- Layout tests running against a stub of GitHub's viewer frame.

### Changed

- The threshold slider is a native `input[type=range]`: it now works from the
  keyboard and is announced by screen readers.
- The chosen threshold is remembered between images.
- Moving the slider no longer reloads and re-decodes both images — only the
  comparison is redone.

### Fixed

- The change bounds now follow the threshold, so the outline and the crop match
  the number of changed pixels reported.

## [0.1.1]

### Fixed

- The Safari note inside the archive is named in Latin characters: some
  unpackers mangled the Cyrillic name.

## [0.1.0]

Initial release: the Pixel Diff mode in GitHub's image viewer, builds for
Chrome, Firefox and Safari.

[0.9.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/releases/tag/v0.1.0
