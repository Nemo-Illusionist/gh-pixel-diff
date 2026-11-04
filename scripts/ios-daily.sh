#!/usr/bin/env bash
# Ежедневная переустановка расширения на iPhone и iPad.
#
# Бесплатная учётная запись подписывает на семь дней, и через неделю iOS
# перестаёт запускать приложение — расширение пропадает из Safari. Продлить
# этот срок нечем, зато можно перестать о нём помнить: пусть мак раз в день
# сам переставляет, пока устройства под рукой.
#
# Несколько раз в день, а не раз в неделю и не раз в сутки, нарочно:
# устройство бывает заперто, унесено или просто не в сети. Одной попытки в
# день оказалось мало — планшет простоял запертым восемь дней подряд и успел
# протухнуть, хотя лежал в двух метрах от мака. Чем чаще заходим, тем выше
# шанс застать его разблокированным.
#
# Лишней работы это не прибавляет: устройство, обновлённое на днях, задание
# пропускает и ничего не пересобирает. Считать свежим то, что моложе
# REFRESH_DAYS, а не всю неделю, — запас на случай, если следующие заходы
# будут промахиваться.
#
# Мака это не касается: там расширение живёт и после того, как подпись
# протухла, и трогать его незачем.
#
# Собирает задание не в этом репозитории, а в своей копии под
# ~/Library/Application Support: папки вроде ~/Documents закрыты защитой
# приватности, и запущенному из launchd процессу туда хода нет — он падал на
# первой же команде, молча, каждый день. В Library хода не требуется, а свежий
# код копия берёт с GitHub по HTTPS: ни ключей, ни доступа к чужим папкам.
# Значит, ставится то, что в main, а не то, что сейчас у вас на руках.
#
#   scripts/ios-daily.sh on       — завести расписание (перезаводит и старое)
#   scripts/ios-daily.sh off      — убрать
#   scripts/ios-daily.sh status   — что сейчас и чем кончилась последняя попытка
#   scripts/ios-daily.sh          — сама попытка, её и зовёт launchd
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="io.github.nemoillusionist.ghpixeldiff.ios-daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ghpixeldiff-ios-daily.log"
# Рабочая копия задания. Запускается не скрипт из копии, а отдельный поводырь
# рядом с ней: копию он обновляет через git, а перезаписывать файл, который
# в этот момент читает bash, — верный способ получить вместо команды мусор.
WORK="$HOME/Library/Application Support/ghpixeldiff"
CLONE="$WORK/repo"
RUNNER="$WORK/ios-daily-runner.sh"
SOURCE="https://github.com/Nemo-Illusionist/gh-pixel-diff.git"
# Часы дневные: ночью мак спит, а запертое с вечера устройство к утру не
# разблокируется само. Разнесены по дню, чтобы попасть и в утро, и в обед, и
# в вечер — когда-нибудь да окажется в руках.
HOURS="10 13 16 19 22"
MINUTE=30
# Когда установка считается свежей. Подписи живут семь дней; четыре оставляют
# трое суток на промахи.
REFRESH_DAYS=4
# Кто и когда обновлялся: строки «идентификатор<TAB>время».
STATE="$WORK/installed.tsv"

case "${1:-run}" in
  on)
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")" "$WORK"
    cat > "$RUNNER" <<RUNNER_BODY
#!/bin/bash
# Создан scripts/ios-daily.sh on — правьте там, здесь перезапишется.
# Сам ничего не решает: обновляет рабочую копию и уходит в её скрипт.
set -uo pipefail
if [ -d "$CLONE/.git" ]; then
  git -C "$CLONE" fetch --quiet --depth 1 origin main &&
    git -C "$CLONE" reset --hard --quiet FETCH_HEAD ||
    echo "Обновить копию не вышло — ставим то, что в ней уже есть."
else
  git clone --quiet --depth 1 "$SOURCE" "$CLONE" || {
    echo "Нет рабочей копии и забрать её не вышло — пропускаем."
    exit 0
  }
fi
exec "$CLONE/scripts/ios-daily.sh" run
RUNNER_BODY
    chmod +x "$RUNNER"
    cat > "$PLIST" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNNER</string>
  </array>
  <key>WorkingDirectory</key><string>$WORK</string>
  <key>StartCalendarInterval</key>
  <array>$(for hour in $HOURS; do
    printf '\n    <dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>%s</integer></dict>' "$hour" "$MINUTE"
  done)
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- Без локали launchd отдаёт журналу вместо «iPad (Пётр)» — «iPad (????)». -->
    <key>LANG</key><string>ru_RU.UTF-8</string>
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
    echo "Расписание заведено: каждый день в $(for hour in $HOURS; do printf '%s:%s ' "$hour" "$MINUTE"; done)"
    echo "Рабочая копия: $CLONE"
    echo "Журнал: $LOG"
    exit 0
    ;;
  off)
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
    rm -f "$PLIST"
    # Рабочая копия — кэш и ничего больше: всё своё она берёт с GitHub.
    rm -rf "$WORK"
    echo "Расписание убрано, рабочая копия удалена."
    exit 0
    ;;
  status)
    if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
      echo "Расписание заведено: каждый день в $(for hour in $HOURS; do printf '%s:%s ' "$hour" "$MINUTE"; done)"
    else
      echo "Расписания нет. Завести: scripts/ios-daily.sh on"
    fi
    if [ -d "$CLONE/.git" ]; then
      echo "Рабочая копия: $(git -C "$CLONE" log -1 --format='%h %s' 2>/dev/null)"
    else
      echo "Рабочей копии ещё нет — заберётся при первой попытке."
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

# Ни одного устройства под рукой — это не беда, а обычный заход: молчим и
# ждём следующего.
DEVICES=$("$ROOT/scripts/ios-devices.sh" || true)
if [ -z "$DEVICES" ]; then
  echo "Устройств на связи нет — пропускаем."
  exit 0
fi

# Кому установка ещё впрок. Пять заходов в день имеют смысл, только если
# четыре из них ничего не делают: собирать и подписывать заново ради
# устройства, обновлённого утром, незачем.
FRESH_AFTER=$(( $(date +%s) - REFRESH_DAYS * 86400 ))
NEEDED=""
while IFS=$'\t' read -r id name; do
  [ -n "$id" ] || continue
  WHEN=$(awk -F'\t' -v id="$id" '$1 == id { when = $2 } END { print when + 0 }' "$STATE" 2>/dev/null)
  if [ "${WHEN:-0}" -gt "$FRESH_AFTER" ]; then continue; fi
  NEEDED="$NEEDED$name"$'\n'
done <<< "$DEVICES"

if [ -z "$NEEDED" ]; then
  echo "Всё свежее — пропускаем."
  exit 0
fi

printf 'Пора обновить: %s\n' "$(printf '%s' "$NEEDED" | paste -sd', ' -)"
# Сборка одна на всех, поэтому зовём установщик один раз: он сам обойдёт все
# подключённые устройства, а свежим переустановка не повредит.
GHPD_STATE="$STATE" "$ROOT/scripts/install-ios.sh"
