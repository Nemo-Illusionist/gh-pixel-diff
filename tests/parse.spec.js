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

test('свой GitHub Enterprise — тот же фрейм на другом хосте', async ({ page }) => {
  // Адрес превью у своего сервера свой: `viewscreen.<хост компании>` при
  // изоляции поддоменов или сам хост без неё. Списка таких адресов не бывает,
  // поэтому хост не проверяется вовсе — решают путь и параметры. Попасть на
  // чужую страницу скрипт всё равно может только там, куда человек сам выдал
  // доступ.
  const pairs = await page.evaluate(() => {
    const hex = (text) =>
      [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    const query =
      `?enc_url1=${hex('https://github.example.com/raw/a/shot.png')}` +
      `&enc_url2=${hex('https://github.example.com/raw/b/shot.png')}&path=shot.png`;
    return {
      enterprise: self.GhPixelDiff.readImagePair(
        `https://viewscreen.github.example.com/diff/img${query}`,
      ),
      // Без изоляции поддоменов превью приходит с самого хоста.
      plain: self.GhPixelDiff.readImagePair(`https://github.example.com/diff/img${query}`),
      // А вот чужая страница на том же хосте — не дифф картинки.
      other: self.GhPixelDiff.readImagePair(`https://github.example.com/owner/repo/pull/1${query}`),
    };
  });

  expect(pairs.enterprise.before).toBe('https://github.example.com/raw/a/shot.png');
  expect(pairs.plain.after).toBe('https://github.example.com/raw/b/shot.png');
  expect(pairs.other).toBeNull();
});

test('находит прямоугольник с различиями', async ({ page }) => {
  // Границы берутся из маски: закрашены в ней только изменившиеся пиксели,
  // остальное прозрачно. Цвет при этом любой — он кодирует направление
  // правки, и искать по нему значит однажды потерять половину изменений.
  const bounds = await page.evaluate(() => {
    const width = 8;
    const height = 8;
    const mask = new Uint8ClampedArray(width * height * 4);
    const mark = (x, y, color) => {
      const i = (y * width + x) * 4;
      mask[i] = color[0];
      mask[i + 1] = color[1];
      mask[i + 2] = color[2];
      mask[i + 3] = 255;
    };
    mark(3, 5, [209, 36, 47]);
    mark(4, 6, [9, 105, 218]);
    return self.GhPixelDiff.boundsOfChanges(mask, width, height);
  });

  expect(bounds).toEqual({ x: 3, y: 5, width: 2, height: 2 });
});

test('разные концы кадра — разные места изменений', async ({ page }) => {
  // Обрезка по общему прямоугольнику для двух правок в разных углах — это
  // весь кадр: обрезать нечего. Поэтому места считаются отдельно, по ним
  // можно ходить, и порядок у них читательский — сверху вниз.
  const found = await page.evaluate(() => {
    const width = 200;
    const height = 120;
    const mask = new Uint8ClampedArray(width * height * 4);
    const mark = (x, y) => {
      mask[(y * width + x) * 4 + 3] = 255;
    };
    // Внизу слева — пятно из двух кусочков с просветом: так выглядит буква,
    // и разваливать её на два места нельзя.
    for (let x = 10; x < 18; x++) mark(x, 100);
    for (let x = 23; x < 30; x++) mark(x, 104);
    // Вверху справа — отдельная правка, далеко от первой.
    for (let y = 10; y < 14; y++) mark(180, y);
    return self.GhPixelDiff.findChanges(mask, width, height);
  });

  expect(found.clusters).toEqual([
    { x: 180, y: 10, width: 1, height: 4, changed: 4 },
    { x: 10, y: 100, width: 20, height: 5, changed: 15 },
  ]);
  // Общий прямоугольник остаётся общим: «показать кадр целиком» опирается
  // на него, и потерять в нём хоть одно изменение нельзя.
  expect(found.bounds).toEqual({ x: 10, y: 10, width: 171, height: 95 });
});

test('мест изменений не бывает больше сорока', async ({ page }) => {
  // Пересжатый JPEG даёт тысячи крошечных пятен, и переходы по ним
  // бесполезны. Остаются самые крупные — и в том же порядке чтения.
  const clusters = await page.evaluate(() => {
    const width = 1000;
    const height = 1000;
    const mask = new Uint8ClampedArray(width * height * 4);
    // Сто пятен по сетке, далеко друг от друга; чем ниже, тем пятно крупнее.
    for (let n = 0; n < 100; n++) {
      const x = (n % 10) * 100 + 10;
      const y = Math.floor(n / 10) * 100 + 10;
      for (let dx = 0; dx <= Math.floor(n / 10); dx++) {
        mask[(y * width + x + dx) * 4 + 3] = 255;
      }
    }
    return self.GhPixelDiff.findChanges(mask, width, height).clusters;
  });

  expect(clusters).toHaveLength(40);
  // Отобрали крупные — это нижние ряды, — а показываем сверху вниз.
  expect(clusters[0].y).toBeLessThan(clusters.at(-1).y);
  expect(clusters.every((box) => box.changed >= 7)).toBe(true);
});

test('без различий прямоугольника нет', async ({ page }) => {
  const bounds = await page.evaluate(() => {
    // Прозрачная маска: не совпало ничего.
    const mask = new Uint8ClampedArray(4 * 4 * 4);
    return self.GhPixelDiff.boundsOfChanges(mask, 4, 4);
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

test('цвет разницы говорит, потемнело или посветлело', async ({ page }) => {
  // «Текст появился» и «текст исчез» — разные события, и по желанию их можно
  // различать на кадре: в настройках включается направление правки цветом.
  await page.addScriptTag({
    path: fileURLToPath(new URL('../src/vendor/pixelmatch.js', import.meta.url)),
  });

  const colors = await page.evaluate(() => {
    const width = 2;
    const height = 1;
    const before = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const after = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);

    const result = self.GhPixelDiff.diffPrepared(
      {
        width,
        height,
        dataBefore: new ImageData(before, width, height),
        dataAfter: new ImageData(after, width, height),
      },
      { colors: { ...self.GhPixelDiff.COLORS, direction: true } },
    );

    const at = (x) => [...result.mask.data.slice(x * 4, x * 4 + 4)];
    return { darker: at(0), lighter: at(1), changed: result.changed };
  });

  expect(colors.changed).toBe(2);
  // Белое стало чёрным — красный; чёрное стало белым — синий.
  expect(colors.darker).toEqual([209, 36, 47, 255]);
  expect(colors.lighter).toEqual([9, 105, 218, 255]);
});

test('цвета разницы можно заменить своими', async ({ page }) => {
  // Красное теряется на красном интерфейсе, а красный с синим различает не
  // всякий дальтонизм. Мусор вместо цвета не должен обесцвечивать разницу:
  // сравнение без цвета — это сравнение без ответа.
  await page.addScriptTag({
    path: fileURLToPath(new URL('../src/vendor/pixelmatch.js', import.meta.url)),
  });

  const painted = await page.evaluate(() => {
    const width = 2;
    const height = 1;
    const prepared = {
      width,
      height,
      dataBefore: new ImageData(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), width, height),
      dataAfter: new ImageData(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]), width, height),
    };
    const at = (result, x) => [...result.mask.data.slice(x * 4, x * 4 + 3)];

    // По умолчанию направление цветом не показывается: разница одного цвета.
    const plain = self.GhPixelDiff.diffPrepared(prepared, {});
    const own = self.GhPixelDiff.diffPrepared(prepared, {
      colors: { direction: true, changed: '#ff8800', lighter: '#00aa44' },
    });
    const broken = self.GhPixelDiff.diffPrepared(prepared, {
      colors: { direction: true, changed: 'оранжевый', lighter: '' },
    });
    return {
      plainDarker: at(plain, 0),
      plainLighter: at(plain, 1),
      darker: at(own, 0),
      lighter: at(own, 1),
      brokenDarker: at(broken, 0),
      brokenLighter: at(broken, 1),
    };
  });

  // Без направления обе стороны правки одного цвета — как было всегда.
  expect(painted.plainDarker).toEqual([209, 36, 47]);
  expect(painted.plainLighter).toEqual([209, 36, 47]);
  expect(painted.darker).toEqual([255, 136, 0]);
  expect(painted.lighter).toEqual([0, 170, 68]);
  // Непонятное значение — обычная пара, а не пустота.
  expect(painted.brokenDarker).toEqual([209, 36, 47]);
  expect(painted.brokenLighter).toEqual([9, 105, 218]);
});

test('сглаживание отмечено, но изменением не считается', async ({ page }) => {
  // Жёлтым отмечено «здесь сдвинулось на полпикселя»: пиксели различаются,
  // но похожи на сглаживание. Считать их изменениями нельзя — от смены шрифта
  // кадр краснел бы целиком. Но и прятать незачем: это ответ, и раньше он был
  // виден. Рисуются такие отметки вполсилы — и по этому же признаку не
  // попадают ни в счёт, ни в границы изменений.
  await page.addScriptTag({
    path: fileURLToPath(new URL('../src/vendor/pixelmatch.js', import.meta.url)),
  });

  const result = await page.evaluate(() => {
    const width = 12;
    const height = 12;
    const shade = (paint) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const value = paint(x);
          const i = (y * width + x) * 4;
          data[i] = value;
          data[i + 1] = value;
          data[i + 2] = value;
          data[i + 3] = 255;
        }
      }
      return new ImageData(data, width, height);
    };

    // Одна и та же вертикальная линия, нарисованная с разным попаданием в
    // пиксельную сетку: слева она темнее, справа размазана на соседа.
    const diff = self.GhPixelDiff.diffPrepared({
      width,
      height,
      dataBefore: shade((x) => (x === 5 ? 0 : x === 6 ? 200 : 255)),
      dataAfter: shade((x) => (x === 5 ? 60 : x === 6 ? 140 : 255)),
    });

    const alphas = {};
    for (let i = 3; i < diff.mask.data.length; i += 4) {
      alphas[diff.mask.data[i]] = (alphas[diff.mask.data[i]] ?? 0) + 1;
    }
    return { alphas, changed: diff.changed, bounds: diff.bounds };
  });

  // Половина столбцов ушла в находки, половина — в отметки сглаживания.
  expect(result.alphas[128]).toBeGreaterThan(0);
  expect(result.changed).toBe(result.alphas[255]);
  // Границы считаются по находкам: отметки их собой не раздвигают.
  expect(result.bounds.width).toBe(1);
});

test('совпавшие пиксели в маске прозрачны', async ({ page }) => {
  // Маска — только изменения: подложку под них выбирает тот, кто рисует.
  await page.addScriptTag({
    path: fileURLToPath(new URL('../src/vendor/pixelmatch.js', import.meta.url)),
  });

  const pixel = await page.evaluate(() => {
    const same = () => new ImageData(new Uint8ClampedArray([12, 34, 56, 255]), 1, 1);
    const result = self.GhPixelDiff.diffPrepared({
      width: 1,
      height: 1,
      dataBefore: same(),
      dataAfter: same(),
    });
    return { alpha: result.mask.data[3], changed: result.changed };
  });

  expect(pixel).toEqual({ alpha: 0, changed: 0 });
});
