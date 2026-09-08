#!/usr/bin/env bash
# Снимки делаются в том же образе, что и тесты: шрифты и отрисовка не зависят
# от того, на чьей машине их обновляли.
set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "Нужен запущенный Docker: снимки делаются в образе $IMAGE" >&2
  exit 1
fi

docker run --rm --ipc=host \
  -v "$ROOT":/work -w /work \
  -e CI=1 \
  "$IMAGE" \
  bash -lc '[ -d node_modules ] || npm ci --no-audit --no-fund; node scripts/build.mjs >/dev/null; node scripts/screenshots.mjs'
