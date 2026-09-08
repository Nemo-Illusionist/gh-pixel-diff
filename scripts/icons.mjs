// Значки всех размеров — из одного src/icons/icon.svg.
//
// Рисовать их руками значит однажды поправить один размер и забыть остальные.
// Отрисовка идёт в том же образе, что тесты и снимки, поэтому результат не
// зависит от того, на чьей машине значок перерисовывали.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const icons = join(root, 'src/icons');
const store = join(root, 'docs/store');

const SIZES = [16, 32, 48, 128];
// Маленькая плитка витрины Chrome: размер задан магазином.
const TILE = { width: 440, height: 280 };

const svg = await readFile(join(icons, 'icon.svg'), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });

/** Значок нужного размера, с прозрачным фоном. */
async function icon(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:transparent}
       svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  return page.screenshot({ omitBackground: true });
}

for (const size of SIZES) {
  await writeFile(join(icons, `icon-${size}.png`), await icon(size));
}

// Плитка: тот же значок плюс название — в списках магазина её показывают
// без подписи, и название должно быть на самой картинке.
await page.setViewportSize(TILE);
await page.setContent(`<!doctype html><meta charset="utf-8">
  <style>
    html, body { margin: 0; height: 100%; }
    body {
      display: flex;
      align-items: center;
      gap: 28px;
      padding: 0 40px;
      box-sizing: border-box;
      background: #f6f8fa;
      font: 16px/1.35 -apple-system, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      color: #1f2328;
    }
    svg { display: block; width: 104px; height: 104px; flex: none; }
    h1 { margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0.01em; }
    p { margin: 8px 0 0; font-size: 15px; color: #59636e; }
  </style>
  ${svg}
  <div><h1>GitHub Pixel Diff</h1><p>See what changed between two images, pixel by pixel.</p></div>`);
await writeFile(join(store, 'promo-tile-440x280.png'), await page.screenshot({ scale: 'css' }));

await browser.close();

console.log(`Значки: src/icons (${SIZES.join(', ')})`);
console.log('Плитка: docs/store/promo-tile-440x280.png');
