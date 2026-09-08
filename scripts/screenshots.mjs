// Снимки для README и витрин магазинов.
//
// Снимаем живую страницу пул-реквеста с настоящим расширением, а не заглушку:
// на витрине люди должны увидеть то же, что получат сами. Язык браузера —
// английский: он основной и в README, и в магазинах.
//
// Витринные кадры магазин принимает только размером 1280×800, поэтому снимок
// панели ещё раз кладётся на страницу-подложку и снимается целиком.
import { chromium } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const extension = join(root, 'dist/chrome');
const shots = join(root, 'docs/screenshots');
const store = join(root, 'dist/store');

const PULL_REQUEST = 'https://github.com/Nemo-Illusionist/gh-pixel-diff/pull/1/files';
const isViewscreen = (url) => url.includes('viewscreen.githubusercontent.com/diff/img');

// Подпись к витринному кадру: заголовок и строка помельче. В магазине их
// читают раньше описания, поэтому каждая говорит про свой кадр.
const STORE = [
  ['frame-changes', 'Pixel diff, cropped to what changed', 'The mode sits next to 2-up, Swipe and Onion Skin'],
  ['frame-full', 'Or the whole frame, if you need the context', 'One click switches between the crop and the full image'],
  ['frame-3up', 'Before, after and the diff side by side', 'Every frame shares one scale and one crop'],
  ['popup', 'One permission, asked once', 'GitHub serves image previews from a separate domain'],
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Кладёт снимок на подложку и снимает её целиком — ровно 1280×800. */
async function compose(page, buffer, title, subtitle) {
  const image = `data:image/png;base64,${buffer.toString('base64')}`;
  await page.setContent(`<!doctype html>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        width: 1280px;
        height: 800px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 28px;
        padding: 56px;
        background: #f6f8fa;
        font: 16px/1.4 -apple-system, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
        color: #1f2328;
        text-align: center;
      }
      h1 { margin: 0; font-size: 30px; font-weight: 600; letter-spacing: -0.01em; }
      p { margin: 8px 0 0; font-size: 17px; color: #59636e; }
      img {
        max-width: 1120px;
        max-height: 560px;
        border: 1px solid #d0d7de;
        border-radius: 10px;
        background: #ffffff;
        box-shadow: 0 12px 32px rgba(31, 35, 40, 0.12);
      }
    </style>
    <div><h1></h1><p></p></div>
    <img alt="">`);
  await page.evaluate(
    ([heading, note, source]) => {
      document.querySelector('h1').textContent = heading;
      document.querySelector('p').textContent = note;
      document.querySelector('img').src = source;
    },
    [title, subtitle, image],
  );
  await page.locator('img').evaluate((node) => node.decode());
  // scale: 'css' — снимки делаются в двойной плотности, а магазин принимает
  // подложку ровно 1280×800.
  return page.screenshot({ scale: 'css' });
}

/** Окно расширения: API браузера подменяем, снимать ради него нечего. */
async function popupShot(page) {
  const messages = JSON.parse(await readFile(join(root, 'src/_locales/en/messages.json'), 'utf8'));
  const { version } = JSON.parse(await readFile(join(root, 'src/manifest.json'), 'utf8'));

  await page.addInitScript(
    ([locale, manifestVersion]) => {
      const getMessage = (key, substitutions = []) => {
        const entry = locale[key];
        if (!entry) return '';
        let text = entry.message;
        for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
          const index = Number(placeholder.content.slice(1)) - 1;
          text = text.replaceAll(`$${name}$`, String(substitutions[index] ?? ''));
        }
        return text;
      };
      globalThis.chrome = {
        i18n: { getMessage },
        runtime: { getManifest: () => ({ version: manifestVersion }) },
        storage: { sync: { get: async (defaults) => defaults, set: async () => {} } },
        // Снимок показывает окно в его обычном виде: доступ уже выдан.
        permissions: { contains: async () => true, request: async () => true },
      };
    },
    [messages, version],
  );

  await page.goto(`file://${join(extension, 'popup/popup.html')}`);
  const size = await page.evaluate(() => {
    const { width, height } = document.body.getBoundingClientRect();
    return { width: Math.ceil(width), height: Math.ceil(height) };
  });
  return page.screenshot({ clip: { x: 0, y: 0, ...size } });
}

const profile = await mkdtemp(join(tmpdir(), 'ghpd-shots-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  // Окно поуже: панель тянется во всю ширину страницы, и в широком окне
  // вокруг кадра остаётся пустое поле. Двойная плотность — чтобы на подложке
  // снимок уменьшался, а не растягивался.
  viewport: { width: 1000, height: 820 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

const written = {};

try {
  const page = await context.newPage();
  await page.goto(PULL_REQUEST, { waitUntil: 'domcontentloaded' });

  // Фрейм GitHub пересоздаёт при перерисовке — берём его заново каждый раз.
  const frame = () => page.frames().find((f) => isViewscreen(f.url()));
  const ready = async (check) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const current = frame();
      const value = current ? await current.evaluate(check).catch(() => null) : null;
      if (value) return;
      await sleep(1000);
    }
    throw new Error('панель не дождалась готовности');
  };

  await ready(() => !!document.querySelector('.ghpd-mode-item input'));
  await frame().evaluate(() => document.querySelector('.ghpd-mode-item input').click());
  await ready(() => /pixels/.test(document.querySelector('.ghpd-meta')?.textContent ?? ''));

  // Снимаем сам фрейм: его рамка и есть граница панели.
  const shoot = async () => {
    await sleep(400);
    return (await frame().frameElement()).screenshot();
  };

  written['frame-changes'] = await shoot();

  await frame().evaluate(() => document.querySelector('.ghpd-crop-toggle').click());
  written['frame-full'] = await shoot();

  await frame().evaluate(() => {
    // Четвёртая кнопка переключателя — три кадра рядом.
    document.querySelectorAll('.ghpd-views .ghpd-view-button')[3].click();
  });
  written['frame-3up'] = await shoot();

  written.popup = await popupShot(await context.newPage());

  // Подложку рисуем в отдельной вкладке нужного размера.
  const canvas = await context.newPage();
  await canvas.setViewportSize({ width: 1280, height: 800 });

  await rm(store, { recursive: true, force: true });
  await mkdir(store, { recursive: true });
  await mkdir(shots, { recursive: true });

  for (const [name, buffer] of Object.entries(written)) {
    await writeFile(join(shots, `${name}.png`), buffer);
  }
  for (const [index, [name, title, subtitle]] of STORE.entries()) {
    const composed = await compose(canvas, written[name], title, subtitle);
    await writeFile(join(store, `screenshot-${index + 1}-${name}.png`), composed);
  }
} finally {
  await context.close();
}

console.log(`Снимки: docs/screenshots (${Object.keys(written).length})`);
console.log(`Витрина: dist/store (${STORE.length} шт., 1280×800)`);
