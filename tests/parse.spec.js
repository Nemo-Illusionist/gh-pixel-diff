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

test('подменяет репозиторий в адресе картинки', async ({ page }) => {
  const result = await page.evaluate(() => {
    const fork = 'https://raw.githubusercontent.com/fork-owner/DaniloFF/abc123/tests/shot.png';
    const repository = { owner: 'DanilovSoft', name: 'DaniloFF' };
    return {
      rewritten: self.GhPixelDiff.rewriteRepository(fork, repository),
      // Тот же репозиторий подменять незачем.
      same: self.GhPixelDiff.rewriteRepository(
        'https://raw.githubusercontent.com/DanilovSoft/DaniloFF/abc123/tests/shot.png',
        repository,
      ),
      // Чужой хост не трогаем.
      foreign: self.GhPixelDiff.rewriteRepository('https://example.com/a.png', repository),
      noRepository: self.GhPixelDiff.rewriteRepository(fork, null),
    };
  });

  expect(result.rewritten).toBe(
    'https://raw.githubusercontent.com/DanilovSoft/DaniloFF/abc123/tests/shot.png',
  );
  expect(result.same).toBeNull();
  expect(result.foreign).toBeNull();
  expect(result.noRepository).toBeNull();
});

test('находит прямоугольник с различиями', async ({ page }) => {
  // Границы берутся из готового диффа: pixelmatch красит изменившийся пиксель
  // в чистый красный, поэтому искать нужно именно его.
  const bounds = await page.evaluate(() => {
    const width = 8;
    const height = 8;
    const diff = new Uint8ClampedArray(width * height * 4);
    // Серый фон — то, чем pixelmatch рисует совпавшие пиксели.
    for (let i = 0; i < diff.length; i += 4) {
      diff[i] = diff[i + 1] = diff[i + 2] = 128;
      diff[i + 3] = 255;
    }
    const mark = (x, y) => {
      const i = (y * width + x) * 4;
      diff[i] = 255;
      diff[i + 1] = 0;
      diff[i + 2] = 0;
    };
    mark(3, 5);
    return self.GhPixelDiff.boundsOfChanges(diff, width, height);
  });

  expect(bounds).toEqual({ x: 3, y: 5, width: 1, height: 1 });
});

test('без различий прямоугольника нет', async ({ page }) => {
  const bounds = await page.evaluate(() => {
    const diff = new Uint8ClampedArray(4 * 4 * 4).fill(128);
    return self.GhPixelDiff.boundsOfChanges(diff, 4, 4);
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

test('увеличение вектора ограничено сверху', async ({ page }) => {
  // Иконке 16×16 без ограничения досталось бы увеличение в 64 раза — холст на
  // тысячу с лишним пикселей по стороне на ровном месте.
  const scales = await page.evaluate(() => {
    const svg = { before: 'https://raw.githubusercontent.com/o/r/a/icon.svg', after: 'https://raw.githubusercontent.com/o/r/b/icon.svg' };
    const png = { before: 'https://raw.githubusercontent.com/o/r/a/shot.png', after: 'https://raw.githubusercontent.com/o/r/b/shot.png' };
    return {
      icon: self.GhPixelDiff.rasterScale(svg, 16, 16),
      middling: self.GhPixelDiff.rasterScale(svg, 200, 300),
      large: self.GhPixelDiff.rasterScale(svg, 2000, 1200),
      raster: self.GhPixelDiff.rasterScale(png, 16, 16),
    };
  });

  expect(scales).toEqual({ icon: 8, middling: 3, large: 1, raster: 1 });
});

test('формы множественного числа берутся по языку интерфейса', async ({ page }) => {
  // У русского форм три, у английского две. Выбирает их Intl, а ключи в
  // локалях должны быть ровно те, что он попросит.
  const forms = await page.evaluate(({ source, locales }) => {
    const said = {};
    for (const [language, messages] of Object.entries(locales)) {
      globalThis.chrome = {
        i18n: {
          getUILanguage: () => language,
          getMessage: (key, subs = []) => {
            const entry = messages[key];
            if (!entry) return '';
            let text = entry.message;
            for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
              const index = Number(placeholder.content.slice(1)) - 1;
              text = text.replaceAll(`$${name}$`, String(subs[index] ?? ''));
            }
            return text;
          },
        },
      };
      // Ссылку на API скрипт берёт при загрузке, поэтому язык меняем вместе с
      // перезагрузкой скрипта.
      new Function('self', source)(globalThis);
      said[language] = [1, 2, 5, 21].map((count) =>
        globalThis.GhPixelDiffI18n.plural('pixels', count),
      );
    }
    return said;
  }, {
    source: readFileSync(fileURLToPath(new URL('../src/content/i18n.js', import.meta.url)), 'utf8'),
    locales: {
      ru: JSON.parse(readFileSync(fileURLToPath(new URL('../src/_locales/ru/messages.json', import.meta.url)), 'utf8')),
      en: JSON.parse(readFileSync(fileURLToPath(new URL('../src/_locales/en/messages.json', import.meta.url)), 'utf8')),
    },
  });

  expect(forms.ru).toEqual(['1 пиксель', '2 пикселя', '5 пикселей', '21 пиксель']);
  expect(forms.en.slice(0, 2)).toEqual(['1 pixel', '2 pixels']);
});
