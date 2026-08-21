#!/usr/bin/env bash
# Оборачивает расширение в проект Xcode для Safari на macOS и iOS.
#
# Конвертер поставляется с Xcode: он создаёт приложение-контейнер, внутри
# которого Safari и запускает расширение — иначе на этих платформах никак.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/build/safari"

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "Нужен Xcode: конвертер safari-web-extension-converter входит в его состав" >&2
  exit 1
fi

node "$ROOT/scripts/build.mjs" >/dev/null
rm -rf "$OUT"
mkdir -p "$OUT"

xcrun safari-web-extension-converter "$ROOT/dist/safari" \
  --project-location "$OUT" \
  --app-name "GitHub Pixel Diff" \
  --bundle-identifier "io.github.nemoillusionist.ghpixeldiff" \
  --no-open \
  --force \
  --no-prompt

echo
echo "Проект: $OUT/GitHub Pixel Diff/GitHub Pixel Diff.xcodeproj"
echo "macOS: собрать схему для My Mac, затем в Safari включить"
echo "       Разработка → Разрешить неподписанные расширения и отметить его в настройках."
echo "iOS:   выбрать схему ...(iOS) и своё устройство, собрать, затем"
echo "       Настройки → Приложения → Safari → Расширения."
