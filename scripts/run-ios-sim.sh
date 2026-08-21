#!/usr/bin/env bash
# Собирает расширение и ставит приложение-контейнер в симулятор iPhone.
#
# Дальше остаётся ручной шаг, который автоматизировать нечем: включить
# расширение в Настройках симулятора (Приложения → Safari → Расширения),
# после чего открыть в Safari любой пул-реквест с изменёнными картинками.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVICE="${1:-iPhone 17 Pro}"
BUNDLE="io.github.nemoillusionist.ghpixeldiff"
DERIVED="$ROOT/build/ios-derived"

"$ROOT/scripts/build-safari.sh" >/dev/null

xcodebuild \
  -project "$ROOT/build/safari/GitHub Pixel Diff/GitHub Pixel Diff.xcodeproj" \
  -scheme "GitHub Pixel Diff (iOS)" \
  -configuration Debug \
  -sdk iphonesimulator \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  build >/dev/null

xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null
xcrun simctl install booted "$DERIVED/Build/Products/Debug-iphonesimulator/GitHub Pixel Diff.app"
xcrun simctl launch booted "$BUNDLE" >/dev/null
open -a Simulator

echo "Приложение установлено в «$DEVICE»."
echo "Осталось вручную: Настройки → Приложения → Safari → Расширения → включить."
