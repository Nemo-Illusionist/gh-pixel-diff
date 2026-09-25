// Снимки для README и витрин магазинов.
//
// Снимаем живую страницу пул-реквеста с настоящим расширением, а не заглушку:
// на витрине люди должны увидеть то же, что получат сами. Язык браузера —
// английский: он основной и в README, и в магазинах.
//
// Витринные кадры магазин принимает только размером 1280×800, поэтому снимок
// панели ещё раз кладётся на страницу-подложку и снимается целиком. Лежат они
// в docs/, а не в dist/: сборка чистит dist целиком, а витрину переснимают
// куда реже, чем собирают.
import { chromium } from '@playwright/test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const extension = join(root, 'dist/chrome');
const shots = join(root, 'docs/screenshots');
const store = join(root, 'docs/store');

const PULL_REQUEST = 'https://github.com/Nemo-Illusionist/gh-pixel-diff/pull/1/files';
const isViewscreen = (url) => url.includes('viewscreen.githubusercontent.com/diff/img');

// Подпись к витринному кадру: заголовок и строка помельче. В магазине их
// читают раньше описания, поэтому каждая говорит про свой кадр.
// Магазин принимает пять кадров. Кадр целиком в эту пятёрку не попал: он
// отличается от первого одной обрезкой, а рассказать хочется о разном.
const STORE = [
  ['frame-changes', 'Pixel diff, cropped to what changed', 'The mode sits next to 2-up, Swipe and Onion Skin'],
  ['frame-overlay', 'The difference over the new version', 'The edit in its own surroundings, not on a grey ghost'],
  ['frame-3up', 'Before, after and the diff side by side', 'Every frame shares one scale and one crop'],
  ['options-store', 'Yours to adjust', 'The colours of the difference — and a GitLab or GitHub Enterprise of your own'],
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

/**
 * Страницы расширения: окно и настройки.
 *
 * Снимать их на живом браузере нечего — за ними нет ни сети, ни страницы;
 * зато нужен API браузера, которого у file:// нет. Поэтому он подменяется.
 */
async function stubBrowser(page) {
  const messages = JSON.parse(await readFile(join(root, 'src/_locales/en/messages.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'src/manifest.json'), 'utf8'));

  await page.addInitScript(
    ([locale, ownManifest]) => {
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
        i18n: { getMessage, getUILanguage: () => 'en' },
        runtime: { getManifest: () => ownManifest, getURL: (path) => path },
        storage: {
          sync: { get: async (defaults) => defaults, set: async () => {} },
          local: { get: async (defaults) => defaults, set: async () => {}, remove: async () => {} },
        },
        // Снимок показывает страницы в их обычном виде: доступ уже выдан, а
        // на странице настроек — по серверу каждого вида, иначе оба списка
        // на кадре пустые и рассказывают не о том.
        permissions: {
          contains: async () => true,
          request: async () => true,
          getAll: async () => ({
            origins: [
              'https://viewscreen.githubusercontent.com/*',
              'https://gitlab.com/*',
              'https://gitlab.example.com/*',
              'https://github.example.com/*',
              'https://viewscreen.github.example.com/*',
            ],
          }),
        },
        scripting: {
          getRegisteredContentScripts: async () => [],
          registerContentScripts: async () => {},
          unregisterContentScripts: async () => {},
        },
      };
    },
    [messages, manifest],
  );
}

/**
 * Снимает страницу расширения.
 *
 * Окно узкое и помещается целиком. Страница настроек длинная: снятая целиком,
 * на витринном кадре она ужимается до нечитаемой ленты. Поэтому у неё берётся
 * кусок от одного раздела до другого — и кончается он на границе раздела, а
 * не на половине строки.
 *
 * @param from откуда резать, селектор раздела; без него — вся страница
 * @param to   докуда: до конца этого раздела
 */
async function pageShot(page, path, { width, from, to } = {}) {
  await stubBrowser(page);
  if (width) await page.setViewportSize({ width, height: 900 });
  await page.goto(`file://${join(extension, path)}`);
  // Надписи и списки расставляются после ответа хранилища — снимок раньше
  // этого показал бы полупустую страницу.
  await page.waitForFunction(() => document.querySelector('h1')?.textContent?.trim());
  await sleep(300);

  const box = await page.evaluate(
    ([start, finish]) => {
      const body = document.body.getBoundingClientRect();
      if (!start) {
        return { x: 0, y: 0, width: Math.ceil(body.width), height: Math.ceil(body.height) };
      }
      const top = document.querySelector(start).getBoundingClientRect();
      const bottom = document.querySelector(finish).getBoundingClientRect();
      const padding = 20;
      return {
        x: Math.max(0, Math.floor(body.x - padding)),
        y: Math.max(0, Math.floor(top.y + scrollY - padding)),
        width: Math.ceil(body.width + padding * 2),
        height: Math.ceil(bottom.bottom - top.y + padding * 2),
      };
    },
    [from, to],
  );
  // fullPage — всегда: страница настроек длиннее окна, и без этого снимок
  // обрезался бы по его нижнему краю, а не по тому, что просили.
  return page.screenshot({ clip: box, fullPage: true });
}

const profile = await mkdtemp(join(tmpdir(), 'ghpd-shots-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  // Ширина окна — не про вкус, а про раскладку GitHub. Он сам решает, какой
  // ширины дать фрейм, и ниже примерно 1400 пикселей кладёт «до» и «после»
  // друг под друга: фрейм становится узким и высоким, а на витринной
  // подложке 1280×800 такой снимок ужимается до нечитаемого. При 1400 фрейм
  // выходит 1022×388 — та же горизонтальная полоса, что была всегда.
  // Двойная плотность — чтобы на подложке снимок уменьшался, а не тянулся.
  viewport: { width: 1400, height: 900 },
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
  //
  // Высоту фрейма задаёт GitHub, и делает он это не сразу: сперва отдаёт
  // полоску в полтораста пикселей, а уже потом растит её под содержимое.
  // Снимок, сделанный в этот промежуток, выходит с кадром, ужатым в точку, —
  // ждём, пока высота перестанет меняться.
  const grown = async () => {
    let previous = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const box = await (await frame().frameElement()).boundingBox();
      const height = Math.round(box?.height ?? 0);
      if (height > 200 && height === previous) return;
      previous = height;
      await sleep(250);
    }
    throw new Error('фрейм так и не вырос');
  };

  const shoot = async () => {
    await grown();
    await sleep(400);
    return (await frame().frameElement()).screenshot();
  };

  written['frame-changes'] = await shoot();

  // Кнопки переключателя ищем по подписи, а не по номеру: их состав растёт,
  // и номер однажды начинает показывать соседний кадр — молча.
  const showFrame = (label) =>
    frame().evaluate((name) => {
      const button = [...document.querySelectorAll('.ghpd-views .ghpd-view-button')].find(
        (node) => node.textContent.trim() === name,
      );
      if (!button) throw new Error(`нет кадра «${name}»`);
      button.click();
    }, label);

  await showFrame('overlay');
  written['frame-overlay'] = await shoot();

  await showFrame('diff');
  await frame().evaluate(() => document.querySelector('.ghpd-crop-toggle').click());
  written['frame-full'] = await shoot();

  await showFrame('3-up');
  written['frame-3up'] = await shoot();

  // «⋯»: порог, рамка и сохранение. В README без этого снимка непонятно, куда
  // делся ползунок, стоявший под кадром прежде.
  await showFrame('diff');
  await frame().evaluate(() => document.querySelector('.ghpd-menu-button').click());
  written['frame-menu'] = await shoot();
  await frame().evaluate(() => document.querySelector('.ghpd-menu-button').click());

  written.popup = await pageShot(await context.newPage(), 'popup/popup.html');

  // Страница настроек нужна дважды и в разном виде. README читают сверху
  // вниз, и там она нужна целиком — начиная с языка. На витринной карточке
  // целая страница ужимается до нечитаемой ленты, поэтому ей достаётся кусок
  // от раздела до раздела: цвета разницы и свои серверы, то есть то, ради
  // чего настройки открывают. Про доступ на витрине рассказывает соседняя
  // карточка с окном расширения.
  written.options = await pageShot(await context.newPage(), 'options/options.html', {
    width: 720,
  });
  written['options-store'] = await pageShot(await context.newPage(), 'options/options.html', {
    width: 720,
    from: 'section:nth-of-type(3)',
    to: '#enterprise',
  });

  // Подложку рисуем в отдельной вкладке нужного размера.
  const canvas = await context.newPage();
  await canvas.setViewportSize({ width: 1280, height: 800 });

  // Чистим только свои кадры: рядом в той же папке лежат рекламные картинки
  // витрины, и делает их другой скрипт — снести их заодно означало бы
  // потерять их молча, до первой же выкладки.
  await mkdir(store, { recursive: true });
  await mkdir(shots, { recursive: true });
  for (const name of await readdir(store)) {
    if (name.startsWith('screenshot-')) await rm(join(store, name));
  }

  for (const [name, buffer] of Object.entries(written)) {
    // Кадры с приставкой «-store» существуют только ради витрины: в README
    // они были бы вторым снимком того же самого, обрезанным иначе.
    if (name.endsWith('-store')) continue;
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
console.log(`Витрина: docs/store (${STORE.length} шт., 1280×800)`);
