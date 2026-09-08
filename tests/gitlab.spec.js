// @ts-check
// Режим Pixel Diff в просмотрщике картинок GitLab.
//
// Разметка взята из image_diff_viewer.vue — того же файла, по которому она
// рисуется у GitLab. Проверяется соседство с ней: наш пункт встаёт в родной
// ряд, родной кадр прячется на время нашего режима и возвращается обратно, а
// просмотрщики, подгруженные прокруткой, получают кнопку наравне с первым.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const read = (path) => readFileSync(file(path));

const messages = JSON.parse(readFileSync(file('../src/_locales/en/messages.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(file('../src/manifest.json'), 'utf8'));
// Состав и порядок берём из манифеста: список, переписанный руками, рано или
// поздно разойдётся с тем, что грузит браузер.
const scripts = manifest.content_scripts.find((entry) =>
  entry.matches.some((match) => match.includes('gitlab.com')),
);

const PAGE = 'https://gitlab.com/owner/repo/-/merge_requests/1/diffs';

async function openPage(page) {
  await page.route('https://gitlab.com/owner/repo/-/merge_requests/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('fixtures/gitlab.html') }),
  );
  // Картинки на своём домене: CORS не нужен, куки нужны — ровно так же, как
  // их отдаёт GitLab в закрытом проекте.
  for (const [path, name] of [
    ['**/raw/aaa/**', 'before.png'],
    ['**/raw/bbb/**', 'after.png'],
  ]) {
    await page.route(path, (route) =>
      route.fulfill({ contentType: 'image/png', body: read(`fixtures/${name}`) }),
    );
  }
  await page.route('https://gitlab.com/__ext/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/__ext/', '');
    return route.fulfill({ contentType: 'text/javascript', body: read(`../src/${path}`) });
  });

  await page.addInitScript((locale) => {
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
    // @ts-ignore — заглушка того куска API, которым пользуется расширение.
    globalThis.chrome = {
      i18n: { getMessage, getUILanguage: () => 'en' },
      runtime: { getURL: (path) => `${location.origin}/__ext/${path}` },
      storage: {
        sync: { get: async (defaults) => defaults },
        local: { get: async (defaults) => defaults, set: async () => {} },
        onChanged: { addListener: () => {} },
      },
    };
  }, messages);

  await page.goto(PAGE);
}

/** Догружает расширение так же, как это делает браузер. */
async function injectExtension(page) {
  for (const style of scripts.css) {
    const css = readFileSync(file(`../src/${style}`), 'utf8');
    // Стиль расширения приходит раньше страничного: при равной силе побеждает
    // страница, и тест должен видеть ту же расстановку сил.
    await page.evaluate((text) => {
      const node = document.createElement('style');
      node.textContent = text;
      document.head.prepend(node);
    }, css);
  }
  for (const script of scripts.js) {
    await page.addScriptTag({ path: file(`../src/${script}`) });
  }
}

const modes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.view-modes-menu li')].map((item) => ({
      text: item.textContent.trim(),
      ours: item.classList.contains('ghpd-mode-item'),
      active: item.classList.contains('active'),
    })),
  );

async function waitForResult(page) {
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.ghpd-meta')?.textContent ?? ''))
    .toMatch(/pixels/);
}

test.beforeEach(async ({ page }) => {
  await openPage(page);
  await injectExtension(page);
});

test('встаёт четвёртым пунктом, родные не трогает', async ({ page }) => {
  await expect.poll(() => modes(page)).toHaveLength(4);

  const items = await modes(page);
  expect(items.map((item) => item.text)).toEqual(['2-up', 'Swipe', 'Onion skin', 'Pixel Diff']);
  expect(items.map((item) => item.ours)).toEqual([false, false, false, true]);
  // Активным остаётся родной: сами мы ничего не переключаем.
  expect(items.map((item) => item.active)).toEqual([true, false, false, false]);
});

test('по нажатию считает разницу и прячет родной кадр', async ({ page }) => {
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  await expect(page.locator('.ghpd-panel')).toBeVisible();
  await expect(page.locator('.diff-viewer > .image')).toBeHidden();
  expect(await page.locator('.ghpd-canvas').first().evaluate((node) => node.width)).toBeGreaterThan(0);
  // Считает отдельный поток: на странице GitLab он собирается из тех же файлов.
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.ghpdWorker),
  ).toBe('on');
});

test('возврат к родному режиму возвращает всё как было', async ({ page }) => {
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  await page.click('.view-modes-menu li:nth-child(1)');

  await expect(page.locator('.ghpd-panel')).toBeHidden();
  await expect(page.locator('.diff-viewer > .image')).toBeVisible();
  const items = await modes(page);
  expect(items.map((item) => item.active)).toEqual([true, false, false, false]);
});

test('кнопка возвращается, если ряд перерисовали', async ({ page }) => {
  await expect.poll(() => modes(page)).toHaveLength(4);

  // Ровно то, что делает Vue при смене активного режима: переписывает список.
  await page.evaluate(() => {
    const menu = document.querySelector('.view-modes-menu');
    menu.replaceChildren(
      ...['2-up', 'Swipe', 'Onion skin'].map((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }),
    );
  });

  await expect.poll(() => modes(page)).toHaveLength(4);
  expect((await modes(page)).at(-1)).toMatchObject({ text: 'Pixel Diff', ours: true });
});

test('просмотрщик, подгруженный прокруткой, тоже получает кнопку', async ({ page }) => {
  await expect.poll(() => modes(page)).toHaveLength(4);

  // GitLab подгружает файлы по мере прокрутки — новый просмотрщик появляется
  // в уже открытой странице, и одного прохода при загрузке мало.
  await page.evaluate(() => {
    const copy = document.querySelector('.diff-file-container').cloneNode(true);
    copy.querySelector('.ghpd-mode-item')?.remove();
    delete copy.querySelector('.diff-viewer').dataset.ghpdReady;
    document.body.append(copy);
  });

  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.ghpd-mode-item').length))
    .toBe(2);
});

test('каждый просмотрщик считает свою пару', async ({ page }) => {
  await page.evaluate(() => {
    const copy = document.querySelector('.diff-file-container').cloneNode(true);
    copy.querySelector('.ghpd-mode-item')?.remove();
    delete copy.querySelector('.diff-viewer').dataset.ghpdReady;
    document.body.append(copy);
  });
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.ghpd-mode-item').length))
    .toBe(2);

  await page.locator('.ghpd-mode-item').nth(1).click();
  await waitForResult(page);

  // Открыт только второй: первый мы не трогали.
  await expect(page.locator('.ghpd-panel')).toHaveCount(1);
  await expect(page.locator('.diff-viewer > .image').nth(1)).toBeHidden();
  await expect(page.locator('.diff-viewer > .image').nth(0)).toBeVisible();
});
