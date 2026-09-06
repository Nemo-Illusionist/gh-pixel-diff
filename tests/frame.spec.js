// @ts-check
// Вёрстка панели на заглушке фрейма.
//
// Всё, что здесь проверяется, ломалось хотя бы раз и находилось глазами на
// скриншотах: то родные режимы показывались разом, то под панелью появлялась
// пустая полоса, то содержимое расползалось по краям высокого фрейма. Логику
// сравнения это не трогает — только то, как расширение уживается с чужой
// разметкой.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const read = (path) => readFileSync(file(path));

const messages = JSON.parse(readFileSync(file('../src/_locales/en/messages.json'), 'utf8'));

const BEFORE = 'https://raw.githubusercontent.com/owner/repo/aaa/shot.png';
const AFTER = 'https://raw.githubusercontent.com/owner/repo/bbb/shot.png';

const hex = (text) => [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

const FRAME_URL =
  'https://viewscreen.githubusercontent.com/diff/img' +
  `?enc_url1=${hex(BEFORE)}&enc_url2=${hex(AFTER)}` +
  `&nwo=owner/repo&path=shot.png&preview=${encodeURIComponent(AFTER)}`;

/** Ставит подмену сети и подкладывает тексты вместо chrome.i18n. */
async function openFrame(page) {
  await page.route('https://viewscreen.githubusercontent.com/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('fixtures/frame.html') }),
  );
  // raw.githubusercontent.com отдаёт картинки с доступом отовсюду — без этого
  // холст стал бы «грязным» и прочитать его было бы нельзя.
  for (const [url, name] of [[BEFORE, 'before.png'], [AFTER, 'after.png']]) {
    await page.route(url, (route) =>
      route.fulfill({
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' },
        body: read(`fixtures/${name}`),
      }),
    );
  }

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
    globalThis.chrome = { i18n: { getMessage, getUILanguage: () => 'en' } };
  }, messages);

  await page.goto(FRAME_URL);
}

/** Догружает расширение в открытую страницу — как это делает браузер. */
async function injectExtension(page) {
  await page.addStyleTag({ path: file('../src/content/frame.css') });
  for (const script of ['../src/vendor/pixelmatch.js', '../src/content/i18n.js',
    '../src/content/compare.js', '../src/content/frame.js']) {
    await page.addScriptTag({ path: file(script) });
  }
}

/** Ждёт, пока сравнение посчитается и подпись перестанет быть «Comparing…». */
async function waitForResult(page) {
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.ghpd-meta')?.textContent ?? ''))
    .toMatch(/pixels/);
}

test('встаёт четвёртой кнопкой, родные не трогает', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);

  const modes = await page.evaluate(() =>
    [...document.querySelectorAll('.js-view-mode-item')].map((item) => ({
      text: item.textContent.trim(),
      ours: item.classList.contains('ghpd-mode-item'),
    })),
  );

  expect(modes.map((mode) => mode.text)).toEqual(['2-up', 'Swipe', 'Onion Skin', 'Pixel Diff']);
  expect(modes.map((mode) => mode.ours)).toEqual([false, false, false, true]);
});

test('в любой момент виден ровно один режим', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);

  const visible = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.view, .ghpd-view')]
        .filter((view) => {
          const style = getComputedStyle(view);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map((view) => view.className),
    );

  expect(await visible()).toEqual(['view view-2-up selected']);

  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  expect(await visible()).toEqual(['ghpd-view']);

  // Возврат к родному: свой контейнер прячем, но какой из трёх показать —
  // решает скрипт GitHub, и его выбор затирать нельзя.
  await page.click('.js-view-modes .js-view-mode-item:nth-child(3)');
  expect(await visible()).toEqual(['view view-onion selected']);
});

test('не меняет высоту документа', async ({ page }) => {
  await openFrame(page);
  // GitHub меряет высоту документа во фрейме и задаёт её фрейму снаружи:
  // всё, что попадает в поток, превращается в пустую полосу под картинкой.
  const before = await page.evaluate(() => document.documentElement.scrollHeight);

  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.js-view-modes .js-view-mode-item:nth-child(1)');

  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(before);
});

test('в высоком фрейме содержимое по центру', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1200 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const gaps = await page.evaluate(() => {
    const view = document.querySelector('.ghpd-view').getBoundingClientRect();
    const canvas = document.querySelector('.ghpd-canvas').getBoundingClientRect();
    const controls = document.querySelector('.ghpd-controls').getBoundingClientRect();
    return { top: canvas.top - view.top, bottom: view.bottom - controls.bottom };
  });

  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThan(24);
});

test('в полном кадре изменения обведены', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-crop-toggle');

  // Кадр целиком показывается уменьшенным, и несколько пикселей на нём не
  // разглядеть — поэтому место правки обводится красным.
  const outline = await page.evaluate(() => {
    const canvas = document.querySelector('.ghpd-canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let found = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 209 && data[i + 1] === 36 && data[i + 2] === 47) found++;
    }
    return found;
  });

  expect(outline).toBeGreaterThan(0);
});

test('ползунок слушается клавиатуры и помнит порог', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  await page.focus('.ghpd-slider');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  expect(await page.inputValue('.ghpd-slider')).toBe('0.12');
  expect(await page.evaluate(() => localStorage.getItem('ghpd:threshold'))).toBe('0.12');

  // Порог переживает переход к следующей картинке — фрейм там новый.
  await page.reload();
  await injectExtension(page);
  expect(await page.inputValue('.ghpd-slider')).toBe('0.12');
});

test('подпись на языке интерфейса', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const meta = await page.textContent('.ghpd-meta');

  expect(meta).toMatch(/^[\d,]+ pixels · [\d.<]+% of the frame/);
  expect(meta).toContain('show the whole frame');
});
