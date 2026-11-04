#!/usr/bin/env bash
# Спаренные настоящие устройства: по строке на каждое, «идентификатор<TAB>имя».
#
# Отдельный скрипт потому, что читают этот список двое — установщик и
# ежедневное задание, — а вывод devicectl уже однажды поменялся: пропало слово
# physical, по которому мы отбирали, и чинить пришлось в двух местах. Второго
# раза не будет.
#
# Симуляторы выдаёт слово simulated в последней колонке: у настоящих она пуста.
#
#   scripts/ios-devices.sh          — все
#   scripts/ios-devices.sh iPhone   — только те, в чьём имени есть «iPhone»
set -euo pipefail

xcrun devicectl list devices 2>/dev/null |
  awk -v want="${1:-}" '
    /available/ && !/simulated/ {
      match($0, /[0-9A-F]{8}-[0-9A-F]{16}/)
      if (!RSTART) next
      id = substr($0, RSTART, RLENGTH)
      name = substr($0, 1, index($0, "  ") - 1)
      if (want == "" || index(tolower(name), tolower(want))) print id "\t" name
    }'
