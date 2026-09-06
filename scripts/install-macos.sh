#!/usr/bin/env bash
# Собирает, подписывает и ставит расширение в Safari на macOS.
#
# Отдельный скрипт нужен из-за двух подводных камней. Первый: без подписи
# настоящим сертификатом macOS расширение не регистрирует, и в списке Safari
# оно не появляется вовсе. Второй: xcodebuild регистрирует собранное
# приложение прямо в папке сборки, и рядом с установленным в Safari появляется
# его двойник — поэтому временную копию снимаем с учёта.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/build/safari/GitHub Pixel Diff/GitHub Pixel Diff.xcodeproj"
DERIVED="$ROOT/build/derived"
APP="GitHub Pixel Diff.app"
EXTENSION_ID="io.github.nemoillusionist.ghpixeldiff.Extension"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister

IDENTITY="${CODE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')}"
if [ -z "$IDENTITY" ]; then
  echo "Нужен сертификат для подписи: добавьте Apple ID в Xcode → Settings → Accounts" >&2
  exit 1
fi

# Идентификатор команды живёт в поле OU сертификата, а не в скобках его имени.
TEAM="${DEVELOPMENT_TEAM:-$(security find-certificate -c "$IDENTITY" -p |
  openssl x509 -noout -subject | sed -n 's/.*OU=\([^,]*\).*/\1/p')}"

echo "Подпись: $IDENTITY (команда $TEAM)"

"$ROOT/scripts/build-safari.sh" >/dev/null

xcodebuild -project "$PROJECT" \
  -scheme "GitHub Pixel Diff (macOS)" \
  -configuration Release \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="$IDENTITY" \
  build >/dev/null

pkill -f "/Applications/$APP" 2>/dev/null || true
rm -rf "/Applications/${APP:?}"
cp -R "$DERIVED/Build/Products/Release/$APP" /Applications/

# Снимаем с учёта копию из папки сборки — иначе Safari покажет два расширения.
"$LSREGISTER" -u "$DERIVED/Build/Products/Release/$APP" 2>/dev/null || true
rm -rf "$DERIVED"

open "/Applications/$APP"
pluginkit -e use -i "$EXTENSION_ID" 2>/dev/null || true

echo
echo "Установлено. Перезапустите Safari, затем: Настройки → Расширения → включить."
pluginkit -m -v -p com.apple.Safari.web-extension 2>/dev/null | grep -i ghpixeldiff || true
