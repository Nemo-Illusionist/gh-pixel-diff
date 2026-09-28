#!/usr/bin/env bash
# Собирает, подписывает и ставит расширение на подключённый iPhone или iPad.
#
# Отдельный скрипт нужен по тем же причинам, что и на маке, плюс одна своя:
# бесплатная учётная запись подписывает на семь дней, и переставлять
# приходится часто — команды собирать заново каждый раз не хочется.
#
# Без имени ставит на все спаренные устройства сразу; с именем — только на
# то, чьё имя названо: scripts/install-ios.sh iPhone
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/build/safari/GitHub Pixel Diff/GitHub Pixel Diff.xcodeproj"
DERIVED="$ROOT/build/ios-device"
WANTED="${1:-}"

IDENTITY="${CODE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')}"
if [ -z "$IDENTITY" ]; then
  echo "Нужен сертификат для подписи: добавьте Apple ID в Xcode → Settings → Accounts" >&2
  exit 1
fi
TEAM="${DEVELOPMENT_TEAM:-$(security find-certificate -c "$IDENTITY" -p |
  openssl x509 -noout -subject | sed -n 's/.*OU=\([^,]*\).*/\1/p')}"

# Настоящие устройства среди спаренных: симуляторы нам тут не нужны.
DEVICES=$(xcrun devicectl list devices 2>/dev/null |
  awk -v want="$WANTED" '
    /physical/ && /available/ {
      match($0, /[0-9A-F]{8}-[0-9A-F]{16}/)
      id = substr($0, RSTART, RLENGTH)
      name = substr($0, 1, index($0, "  ") - 1)
      if (want == "" || index(tolower(name), tolower(want))) print id "\t" name
    }')

if [ -z "$DEVICES" ]; then
  echo "Не вижу подключённых устройств${WANTED:+ по имени «$WANTED»}." >&2
  echo "Устройство должно быть разблокировано и спарено; по кабелю надёжнее, чем по Wi-Fi." >&2
  exit 1
fi

"$ROOT/scripts/build-safari.sh" >/dev/null

echo "Подпись: $IDENTITY (команда $TEAM)"
xcodebuild -project "$PROJECT" \
  -scheme "GitHub Pixel Diff (iOS)" \
  -configuration Release \
  -destination generic/platform=iOS \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$TEAM" \
  -allowProvisioningUpdates \
  build >/dev/null

APP="$DERIVED/Build/Products/Release-iphoneos/GitHub Pixel Diff.app"

while IFS=$'\t' read -r id name; do
  echo
  echo "→ $name"
  xcrun devicectl device install app --device "$id" "$APP" >/dev/null
  echo "  поставлено"
done <<< "$DEVICES"

echo
echo "Осталось вручную на каждом: Настройки → Приложения → Safari → Расширения → включить."
