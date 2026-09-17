// @ts-check
// Отдельная страница: две картинки руками — та же разница, что во фрейме.
//
// Проверяем собранную страницу, а не исходники: она склеивается из файлов
// расширения скриптом сборки, и сломаться может именно склейка — забытый файл,
// разъехавшийся порядок подключения, потерянные локали.
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

const site = fileURLToPath(new URL('../dist/site', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let server;
let origin;

// Через file:// проверять нельзя: оттуда браузер не заводит Worker, и мы
// проверяли бы не ту ветку, по которой страница идёт у людей.
test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const path = normalize(new URL(request.url, 'http://localhost').pathname);
    const name = path === '/' ? '/index.html' : path;
    try {
      const body = await readFile(join(site, name));
      response.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => new Promise((done) => server.close(done)));

/** Кладёт обе картинки в половины страницы. */
async function load(page, before = 'before.png', after = 'after.png') {
  await page.setInputFiles('.drop[data-slot=before] input', fixture(before));
  await page.setInputFiles('.drop[data-slot=after] input', fixture(after));
}

const meta = (page) => page.locator('#meta');

test.beforeEach(async ({ page }) => {
  await page.goto(origin);
});

test('две картинки — и видно разницу', async ({ page }) => {
  await expect(page.locator('#panel')).toBeHidden();

  await load(page);

  await expect(meta(page)).toContainText(/pixels?/);
  await expect(page.locator('#panel')).toBeVisible();
  // Разница считается в отдельном потоке: на странице он свой, без blob.
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.ghpdWorker),
  ).toBe('on');
});

test('пока картинка одна, сравнивать нечего', async ({ page }) => {
  await page.setInputFiles('.drop[data-slot=before] input', fixture('before.png'));

  await expect(page.locator('#failure')).toBeVisible();
  await expect(page.locator('#panel')).toBeHidden();
});

test('по умолчанию показан фрагмент, а не весь кадр', async ({ page }) => {
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);

  const cropped = await page.locator('#canvas').evaluate((node) => node.width);
  await page.locator('.ghpd-crop-toggle').click();
  const whole = await page.locator('#canvas').evaluate((node) => node.width);

  expect(cropped).toBeLessThan(whole);
});

test('переключатель показывает три кадра сразу', async ({ page }) => {
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);

  await page.locator('.ghpd-view-button', { hasText: '3-up' }).click();

  await expect(page.locator('#canvas')).toBeHidden();
  await expect(page.locator('#triple .ghpd-canvas')).toHaveCount(3);
  for (const size of await page.locator('#triple .ghpd-canvas').evaluateAll(
    (nodes) => nodes.map((node) => node.width),
  )) {
    expect(size).toBeGreaterThan(0);
  }
});

test('порог меняет число найденных пикселей', async ({ page }) => {
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);
  const count = () =>
    page.evaluate(() => Number(document.querySelector('#meta strong').textContent.replace(/\D/g, '')));

  // Порог уехал под «⋯» — сперва открываем меню.
  await page.locator('.ghpd-menu-button').click();

  const sensitive = await (async () => {
    await page.locator('#threshold').fill('0');
    await expect.poll(count).toBeGreaterThan(0);
    return count();
  })();

  await page.locator('#threshold').fill('0.5');
  await expect.poll(count).toBeLessThan(sensitive);
});

/** Самый частый цвет непрозрачных пикселей кадра — цвет отметок разницы. */
async function markColor(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      // Серая подложка «разницы» — обесцвеченное «до»: у неё все три канала
      // равны. Отметки цветные, их и ищем.
      if (data[i] === data[i + 1] && data[i + 1] === data[i + 2]) continue;
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  });
}

test('цвет разницы задаётся на странице и применяется сразу', async ({ page }) => {
  // Цвет запечён в маску, поэтому смена цвета — это пересчёт, а не отрисовка.
  // Проверяем именно кадр: настройка, не доехавшая до картинки, бесполезна.
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);

  expect(await markColor(page)).toBe('209,36,47');

  await page.locator('#tune').click();
  await page.locator('#color-changed').evaluate((node) => {
    node.value = '#00a000';
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect.poll(() => markColor(page)).toBe('0,160,0');

  // И выбор переживает перезагрузку: он в localStorage этой страницы.
  await page.reload();
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);
  expect(await markColor(page)).toBe('0,160,0');
});

test('бета включается на странице и меняет ответ', async ({ page }) => {
  // Пара со сдвигом: наверху добавлен блок, и всё ниже съехало. Без сшивания
  // изменившимся оказывается почти весь кадр.
  await load(page, 'shifted-before.png', 'shifted-after.png');
  await expect(meta(page)).toContainText(/pixels?/);
  const count = () =>
    page.evaluate(() =>
      Number(document.querySelector('#meta strong').textContent.replace(/\D/g, '')),
    );

  const было = await count();

  await page.locator('#tune').click();
  await page.locator('#beta').check();

  // Ответ пересчитан, и найденного заметно меньше: переехавшие строки
  // сошлись со своими и перестали считаться изменившимися.
  await expect.poll(count).toBeLessThan(было / 2);
  // Сдвиг назван словами, а не только числом.
  await expect(meta(page)).toContainText(/rows|строк/);
});

test('переключатель кадров можно спрятать, и он не запирает в «3-up»', async ({ page }) => {
  // Спрятанный переключатель не должен оставлять в том кадре, который был
  // выбран до него: из «3-up» иначе не выйти, и сохранение в нём погашено.
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);

  await page.locator('.ghpd-view-button', { hasText: '3-up' }).click();
  await expect(page.locator('#canvas')).toBeHidden();

  await page.locator('#tune').click();
  await page.locator('#show-views').uncheck();

  await expect(page.locator('#views')).toBeHidden();
  await expect(page.locator('#canvas')).toBeVisible();
});

test('язык переключается на месте, не теряя картинок', async ({ page }) => {
  // Перезагрузка была бы дешевле, но унесла бы обе картинки: они лежат в
  // памяти, а не в адресе.
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);

  await page.locator('#tune').click();
  await page.locator('#language').selectOption('ru');

  await expect(meta(page)).toContainText(/пиксел/);
  // Надписи, поставленные один раз при запуске, тоже переставлены.
  await expect(page.locator('.ghpd-view-button').first()).toHaveText('до');
  await expect(page.locator('.ghpd-crop-toggle')).toContainText('весь кадр');
  // Картинки на месте: панель никуда не девалась.
  await expect(page.locator('#canvas')).toBeVisible();

  // И выбор помнится: он в localStorage этой страницы.
  await page.reload();
  await expect(page.locator('#language')).toHaveValue('ru');
});

test('не картинка — понятный отказ, а не молчание', async ({ page }) => {
  await page.setInputFiles('.drop[data-slot=before] input', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('не картинка'),
  });

  await expect(page.locator('#failure')).toContainText('notes.txt');
});

test('убрать картинку — и сравнивать снова нечего', async ({ page }) => {
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);

  await page.locator('.drop[data-slot=before] .drop-clear').click();

  await expect(page.locator('#panel')).toBeHidden();
  await expect(page.locator('#failure')).toBeVisible();
  await expect(page.locator('.drop[data-slot=before] .drop-preview')).toBeHidden();
  // Половина «после» не тронута: убирали не её.
  await expect(page.locator('.drop[data-slot=after] .drop-preview')).toBeVisible();
});

test('«начать заново» очищает обе половины', async ({ page }) => {
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);

  await page.locator('#reset').click();

  await expect(page.locator('.drop-preview')).toHaveCount(2);
  await expect(page.locator('.drop-preview:visible')).toHaveCount(0);
  await expect(page.locator('.drop-clear:visible')).toHaveCount(0);
});

test('одну и ту же половину можно заменить', async ({ page }) => {
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);

  // Тот же файл в обе половины: разницы быть не должно, и это видно.
  await page.setInputFiles('.drop[data-slot=after] input', fixture('before.png'));

  await expect(meta(page)).toContainText('0');
  await expect(page.locator('#panel')).toBeVisible();
});

test('увеличение работает и на странице, и сбрасывается новой картинкой', async ({ page }) => {
  // Увеличение живёт в общем с расширением коде — здесь проверяется, что
  // страница его подключила, а не что оно вообще считает.
  await load(page);
  await expect(meta(page)).toContainText(/pixels?/);

  const отпечаток = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('#canvas');
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum = (sum * 31 + data[i]) % 1e9;
      return sum;
    });

  const было = await отпечаток();
  await page.evaluate(() => {
    const canvas = document.querySelector('#canvas');
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', {
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      deltaY: -600,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
  });

  await expect(page.locator('.ghpd-zoom-reset')).toContainText('zoom');
  expect(await отпечаток()).not.toBe(было);

  // Новая картинка — новое место: держать на ней прежнее увеличение незачем.
  await page.setInputFiles('.drop[data-slot=after] input', fixture('before.png'));
  await expect(page.locator('.ghpd-zoom-reset')).toBeHidden();
});

test('строки не пропадают, даже если window.chrome защищён от записи', async ({ page }) => {
  // Ровно та поломка, из-за которой страница вышла в свет без единой надписи:
  // страница присваивала window.chrome, а это имя принадлежит браузеру. Там,
  // где оно закрыто на запись, присваивание в строгом режиме роняло скрипт со
  // строками — и весь интерфейс оказывался пустым, молча.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'chrome', { value: {}, writable: false, configurable: false });
  });
  await page.goto(origin);

  const empty = await page.evaluate(() =>
    [...document.querySelectorAll('[data-i18n]')]
      .filter((node) => !node.textContent.trim())
      .map((node) => node.dataset.i18n),
  );

  expect(empty).toEqual([]);
});

test('строки страницы берутся из локалей расширения', async ({ page }) => {
  // Пустой текст здесь означает потерянный ключ или несобранные локали —
  // на живой странице это выглядело бы как пустое место, и молча.
  const empty = await page.evaluate(() =>
    [...document.querySelectorAll('[data-i18n]')]
      .filter((node) => !node.textContent.trim())
      .map((node) => node.dataset.i18n),
  );

  expect(empty).toEqual([]);
});
