// Версия Playwright должна быть одна на весь репозиторий.
//
// Её тут шесть штук: одна в package.json и пять зашитых в образ
// mcr.microsoft.com/playwright — в скриптах и в workflow. Dependabot видит
// только первую: про остальные он не знает, они для него просто текст.
//
// Разъехавшись, они ломаются тихо. Браузеры лежат в образе, а библиотека,
// которая ими правит, приходит из npm, и несовпадение версий даёт не
// понятный отказ, а странные падения тестов — или, хуже, зелёный прогон на
// браузере не той версии, чем у людей.
//
// Поэтому вхождения ищутся по всему дереву, а не перечисляются руками:
// появится шестое место — оно попадёт под проверку само.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const IMAGE = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)/g;
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'test-results']);

const want = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  .devDependencies['@playwright/test'];

/** Все файлы дерева, кроме собранного и чужого. */
async function* walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(item.name)) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const wrong = [];
let found = 0;
for await (const path of walk(root)) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // Двоичный файл — там версии быть не может.
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(IMAGE)) {
      found++;
      if (match[1] !== want) {
        wrong.push(`${path.slice(root.length)}:${index + 1}: ${match[1]}`);
      }
    }
  });
}

if (!found) {
  console.error('Не нашлось ни одного образа Playwright — проверка потеряла смысл.');
  console.error('Либо образ больше не используется, либо изменилась его запись.');
  process.exit(1);
}

if (wrong.length) {
  console.error(`В package.json Playwright ${want}, а в образе — другой:`);
  for (const line of wrong) console.error(`  ${line}`);
  console.error('');
  console.error('Браузеры лежат в образе, библиотека приходит из npm: разойдясь,');
  console.error('они дают странные падения или зелёный прогон не на том браузере.');
  process.exit(1);
}

console.log(`Playwright ${want} — одинаково во всех ${found} местах.`);
