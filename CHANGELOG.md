# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [semantic versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Nemo-Illusionist/gh-pixel-diff/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Nemo-Illusionist/gh-pixel-diff/releases/tag/v0.1.0
