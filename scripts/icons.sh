#!/usr/bin/env bash
# Значки рисуются в том же образе, что тесты и снимки: отрисовка шрифтов и
# сглаживание не должны зависеть от машины.
set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "Нужен запущенный Docker: значки рисуются в образе $IMAGE" >&2
  exit 1
fi

docker run --rm --ipc=host \
  -v "$ROOT":/work -w /work \
  "$IMAGE" \
  bash -lc '[ -d node_modules ] || npm ci --no-audit --no-fund; node scripts/icons.mjs'
