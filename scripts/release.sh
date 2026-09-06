#!/usr/bin/env bash
# Готовит релиз: поднимает версию и открывает пул-реквест.
#
# Прямой push в main запрещён, поэтому коммит с версией едет обычным
# пул-реквестом. Тег ставится уже после слияния — он и запускает сборку.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Использование: npm run release -- 0.6.0" >&2
  exit 1
fi
VERSION="${VERSION#v}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Сначала разберитесь с незакоммиченными изменениями" >&2
  exit 1
fi

BRANCH="release-$VERSION"
git switch -c "$BRANCH"

# --no-git-tag-version: тег ставим после слияния, на main. Хук `version` при
# этом всё равно отработает и перенесёт версию в манифест.
npm version "$VERSION" --no-git-tag-version >/dev/null
git add package.json package-lock.json src/manifest.json CHANGELOG.md 2>/dev/null || true
git commit -q -m "Версия $VERSION"
git push -q -u origin "$BRANCH"

gh pr create --title "Версия $VERSION" --body "$(cat <<NOTES
Поднимает версию до $VERSION.

После слияния — поставить тег, он запустит сборку и публикацию:

\`\`\`
git switch main && git pull
git tag v$VERSION && git push origin v$VERSION
\`\`\`
NOTES
)"

echo
echo "Дальше: дождаться зелёного CI, слить пул-реквест, затем"
echo "  git switch main && git pull && git tag v$VERSION && git push origin v$VERSION"
