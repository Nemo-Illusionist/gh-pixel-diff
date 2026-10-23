#!/usr/bin/env bash
# Ежедневная переустановка расширения на iPhone и iPad.
#
# Бесплатная учётная запись подписывает на семь дней, и через неделю iOS
# перестаёт запускать приложение — расширение пропадает из Safari. Продлить
# этот срок нечем, зато можно перестать о нём помнить: пусть мак раз в день
# сам переставляет, пока устройства под рукой.
#
# Каждый день, а не раз в неделю, нарочно: устройство бывает заперто, унесено
# или просто не в сети, и промах не должен ничего стоить. Не вышло сегодня —
# выйдет завтра, лишь бы хоть одна попытка за неделю удалась.
#
# Мака это не касается: там расширение живёт и после того, как подпись
# протухла, и трогать его незачем.
#
#   scripts/ios-daily.sh on       — завести расписание
#   scripts/ios-daily.sh off      — убрать
#   scripts/ios-daily.sh status   — что сейчас и чем кончилась последняя попытка
#   scripts/ios-daily.sh          — сама попытка, её и зовёт launchd
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="io.github.nemoillusionist.ghpixeldiff.ios-daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ghpixeldiff-ios-daily.log"
# Час выбран дневной: ночью мак спит, а запертое с вечера устройство к утру
# не разблокируется само.
HOUR=14
MINUTE=30

case "${1:-run}" in
  on)
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat > "$PLIST" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/scripts/ios-daily.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST_BODY
    # bootout перед bootstrap: иначе повторное «on» упрётся в уже заведённое.
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$UID" "$PLIST"
    echo "Расписание заведено: каждый день в $HOUR:$MINUTE."
    echo "Журнал: $LOG"
    exit 0
    ;;
  off)
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
    rm -f "$PLIST"
    echo "Расписание убрано."
    exit 0
    ;;
  status)
    if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
      echo "Расписание заведено: каждый день в $HOUR:$MINUTE."
    else
      echo "Расписания нет. Завести: scripts/ios-daily.sh on"
    fi
    [ -f "$LOG" ] && { echo; echo "Последняя попытка:"; tail -12 "$LOG"; }
    exit 0
    ;;
  run) ;;
  *)
    echo "Так нельзя: ${1}. Можно on, off, status — или без слов, тогда это сама попытка." >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$LOG")"
# Журнал не должен расти без конца: держим последнюю тысячу строк.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
  tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo
echo "=== $(date '+%Y-%m-%d %H:%M') ==="

# Ни одного устройства под рукой — это не беда, а обычный день: молчим и
# ждём следующего.
if ! xcrun devicectl list devices 2>/dev/null | grep -v simulated | grep -q available; then
  echo "Устройств на связи нет — пропускаем."
  exit 0
fi

"$ROOT/scripts/install-ios.sh"
