## Installation

**Chrome, Edge, any Chromium** — download `gh-pixel-diff-chrome-*.zip`, unpack
it, open `chrome://extensions`, turn on "Developer mode" and press "Load
unpacked" → the unpacked folder.

**Firefox** — the add-on is on
[addons.mozilla.org](https://addons.mozilla.org/addon/github-pixel-diff/). To
try this build instead, download `gh-pixel-diff-firefox-*.zip`, open
`about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → pick the
archive. It lives until the browser restarts.

**Safari, macOS and iOS** — download `gh-pixel-diff-safari-*.zip`, unpack it and
follow `SAFARI-INSTALL.txt` inside. Xcode and your own certificate are required:
without a signature macOS won't register the extension.

After installing, open the extension popup and grant access — GitHub serves
image previews from `viewscreen.githubusercontent.com`, and GitLab renders them
on `gitlab.com`.

**No pull request at hand?** Two images of your own compare the same way at
<https://nemo-illusionist.github.io/gh-pixel-diff/>.

SHA-256 sums for every archive are in `checksums.txt`.
