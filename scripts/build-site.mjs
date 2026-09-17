// Сборка отдельной страницы в dist/site.
//
// Логика сравнения и отрисовки не копируется руками, а берётся из src/: у
// расширения и у страницы должна быть одна копия, иначе они разойдутся на
// первой же правке. Тексты — из тех же локалей, только уложенные в файл,
// который страница может подключить обычным тегом.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'dist/site');

/** Что берём из расширения: слева — откуда, справа — под каким именем. */
const SHARED = [
  ['src/vendor/pixelmatch.js', 'pixelmatch.js'],
  ['src/content/compare.js', 'compare.js'],
  ['src/content/render.js', 'render.js'],
  ['src/content/worker.js', 'worker.js'],
  ['src/content/i18n.js', 'i18n.js'],
  ['src/content/panel.css', 'panel.css'],
  ['src/icons/icon.svg', 'icon.svg'],
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await cp(join(root, 'site'), out, { recursive: true });

for (const [from, name] of SHARED) {
  await cp(join(root, from), join(out, name));
}

// Все локали кладём разом: язык выбирается уже в браузере, по его настройке.
const locales = {};
for (const name of await readdir(join(root, 'src/_locales'))) {
  locales[name] = JSON.parse(
    await readFile(join(root, 'src/_locales', name, 'messages.json'), 'utf8'),
  );
}
await writeFile(
  join(out, 'messages.js'),
  `// Собрано из src/_locales — править там.\nself.__GHPD_MESSAGES = ${JSON.stringify(locales)};\n`,
);

console.log(`Страница: dist/site (локали: ${Object.keys(locales).join(', ')})`);
