#!/usr/bin/env bash
# Собирает архивы для раздачи: их же выкладывает релиз на GitHub.
#
# Архивы делаются из dist/, а не из репозитория целиком: в поставку попадает
# ровно то, что браузер грузит как расширение.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./src/manifest.json').version")"
OUT="$ROOT/dist/release"

node scripts/build.mjs >/dev/null
rm -rf "$OUT"
mkdir -p "$OUT"

pack() {
  local target="$1"
  local name="gh-pixel-diff-$target-$VERSION.zip"
  (cd "dist/$target" && zip -qr -X "$OUT/$name" .)
  echo "$name"
}

pack chrome
pack firefox

# Safari берёт не архив, а проект Xcode, поэтому к папке кладётся памятка:
# скачавший её отдельно от релиза иначе не поймёт, что с ней делать.
# Имя латиницей: кириллица в zip читается не всеми распаковщиками одинаково.
cat > "dist/safari/SAFARI-INSTALL.txt" <<'NOTE'
Safari не ставит расширения из папки — нужен проект Xcode и подпись.

  xcrun safari-web-extension-converter . \
    --app-name "GitHub Pixel Diff" \
    --bundle-identifier io.github.nemoillusionist.ghpixeldiff \
    --no-prompt

Дальше открыть полученный проект, в настройках цели выбрать свою команду
разработчика, собрать схему «GitHub Pixel Diff (macOS)» и запустить
приложение. В Safari: Настройки → Дополнения → включить расширение.

Затем нажать кнопку расширения в панели Safari и разрешить доступ:
картинки живут в кросс-доменном фрейме, и разрешение для github.com
на него не распространяется.

Подробности — https://github.com/Nemo-Illusionist/gh-pixel-diff
NOTE
pack safari

# Контрольные суммы — чтобы скачанный архив можно было сверить с релизом.
(cd "$OUT" && shasum -a 256 ./*.zip > checksums.txt)

echo
echo "Архивы: dist/release (версия $VERSION)"
