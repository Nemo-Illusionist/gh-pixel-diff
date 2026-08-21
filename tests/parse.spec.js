// @ts-check
// Разбор адресов: что расширение вытащит из iframe'а GitHub, а что отбросит.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const compareSource = readFileSync(
  fileURLToPath(new URL('../src/content/compare.js', import.meta.url)),
  'utf8',
);

const hex = (text) => [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><title>fixture</title>');
  await page.addScriptTag({ content: compareSource });
});

test('вытаскивает обе версии картинки из адреса iframe', async ({ page }) => {
  const before = 'https://raw.githubusercontent.com/o/r/aaa/shot.png';
  const after = 'https://raw.githubusercontent.com/o/r/bbb/shot.png';
  const src = `https://viewscreen.githubusercontent.com/diff/img?enc_url1=${hex(before)}&enc_url2=${hex(after)}&path=shot.png`;

  const pair = await page.evaluate((value) => self.GhPixelDiff.readImagePair(value), src);

  expect(pair).toEqual({ before, after, path: 'shot.png' });
});

test('отбрасывает чужие адреса и битые данные', async ({ page }) => {
  const cases = [
    'https://example.com/diff/img?enc_url1=6161&enc_url2=6262',
    'https://viewscreen.githubusercontent.com/diff/img',
    `https://viewscreen.githubusercontent.com/diff/img?enc_url1=${hex('https://a.png')}`,
    // Нечётная длина, не-hex и адрес без https — всё это не адрес картинки.
    'https://viewscreen.githubusercontent.com/diff/img?enc_url1=abc&enc_url2=abc',
    'https://viewscreen.githubusercontent.com/diff/img?enc_url1=zzzz&enc_url2=zzzz',
    `https://viewscreen.githubusercontent.com/diff/img?enc_url1=${hex('javascript:alert(1)')}&enc_url2=${hex('https://b.png')}`,
  ];

  for (const src of cases) {
    const pair = await page.evaluate((value) => self.GhPixelDiff.readImagePair(value), src);
    expect(pair, src).toBeNull();
  }
});

test('находит прямоугольник с различиями', async ({ page }) => {
  const bounds = await page.evaluate(() => {
    const width = 8;
    const height = 8;
    const a = new Uint8ClampedArray(width * height * 4).fill(255);
    const b = new Uint8ClampedArray(a);
    // Помечаем один пиксель в точке (3, 5).
    const i = (5 * width + 3) * 4;
    b[i] = 0;
    return self.GhPixelDiff.boundsOfChanges(a, b, width, height);
  });

  expect(bounds).toEqual({ x: 3, y: 5, width: 1, height: 1 });
});

test('без различий прямоугольника нет', async ({ page }) => {
  const bounds = await page.evaluate(() => {
    const a = new Uint8ClampedArray(4 * 4 * 4).fill(7);
    return self.GhPixelDiff.boundsOfChanges(a, new Uint8ClampedArray(a), 4, 4);
  });

  expect(bounds).toBeNull();
});

test('считает изменившиеся пиксели', async ({ page }) => {
  await page.addScriptTag({
    path: fileURLToPath(new URL('../src/vendor/pixelmatch.js', import.meta.url)),
  });

  const changed = await page.evaluate(() => {
    const size = 10;
    const make = (fill) => {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);
      if (fill) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, 2, 2);
      }
      return ctx.getImageData(0, 0, size, size);
    };
    const a = make(false);
    const b = make(true);
    return self.pixelmatch(a.data, b.data, null, size, size);
  });

  expect(changed).toBe(4);
});
