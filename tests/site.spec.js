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

  const sensitive = await (async () => {
    await page.locator('#threshold').fill('0');
    await expect.poll(count).toBeGreaterThan(0);
    return count();
  })();

  await page.locator('#threshold').fill('0.5');
  await expect.poll(count).toBeLessThan(sensitive);
});

test('не картинка — понятный отказ, а не молчание', async ({ page }) => {
  await page.setInputFiles('.drop[data-slot=before] input', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('не картинка'),
  });

  await expect(page.locator('#failure')).toContainText('notes.txt');
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
