// Сборка расширения под три браузера из общего src/.
//
// Код везде один и тот же: content script без фонового процесса, поэтому
// расходится только манифест. Firefox требует собственный идентификатор,
// Safari довольствуется копией chrome-сборки.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

const FIREFOX_ID = 'gh-pixel-diff@nemo-illusionist.github.io';

async function build(target, patch) {
  const out = join(dist, target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(src, out, { recursive: true });

  const manifest = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
  patch(manifest);
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`${target}: dist/${target}`);
}

await rm(dist, { recursive: true, force: true });

await build('chrome', () => {});

await build('firefox', (manifest) => {
  // Без явного идентификатора Firefox не подпишет расширение, а без
  // объявления о сборе данных не пропустит проверку: не собираем ничего.
  manifest.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: '128.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
});

await build('safari', () => {});

console.log('\nДальше:');
console.log('  Chrome  — chrome://extensions → «Загрузить распакованное» → dist/chrome');
console.log('  Firefox — about:debugging → «Загрузить временное дополнение» → dist/firefox/manifest.json');
console.log('  Safari  — npm run build:safari (нужен Xcode)');
