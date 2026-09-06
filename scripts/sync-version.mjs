// Переносит версию из package.json в манифест расширения.
//
// Вызывается npm-хуком `version`, поэтому `npm version 0.2.0` правит оба файла
// и кладёт их в один коммит: релиз сверяет тег именно с манифестом.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
const manifest = fileURLToPath(new URL('../src/manifest.json', import.meta.url));

const { version } = JSON.parse(await readFile(pkg, 'utf8'));
const data = JSON.parse(await readFile(manifest, 'utf8'));

data.version = version;
await writeFile(manifest, `${JSON.stringify(data, null, 2)}\n`);

console.log(`Версия в манифесте: ${version}`);
