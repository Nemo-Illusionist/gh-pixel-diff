#!/usr/bin/env bash
# Тесты идут в образе Playwright: расширение проверяется в настоящем Chromium,
# и результат не зависит от того, что стоит на машине.
set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "Нужен запущенный Docker: тесты идут в образе $IMAGE" >&2
  exit 1
fi

docker run --rm --ipc=host \
  -v "$ROOT":/work -w /work \
  -e CI=1 \
  "$IMAGE" \
  bash -lc '[ -d node_modules ] || npm ci --no-audit --no-fund; node scripts/build.mjs >/dev/null; npx playwright test "$@"' _ "$@"
