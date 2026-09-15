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

const BEFORE_SVG = 'https://raw.githubusercontent.com/owner/repo/aaa/logo.svg';
const AFTER_SVG = 'https://raw.githubusercontent.com/owner/repo/bbb/logo.svg';

const FRAME_URL =
  'https://viewscreen.githubusercontent.com/diff/img' +
  `?enc_url1=${hex(BEFORE)}&enc_url2=${hex(AFTER)}` +
  `&nwo=owner/repo&path=shot.png&preview=${encodeURIComponent(AFTER)}`;

const FRAME_URL_SVG =
  'https://viewscreen.githubusercontent.com/diff/img' +
  `?enc_url1=${hex(BEFORE_SVG)}&enc_url2=${hex(AFTER_SVG)}` +
  `&nwo=owner/repo&path=logo.svg&preview=${encodeURIComponent(AFTER_SVG)}`;

/**
 * Пара векторных картинок. `size` — с собственным размером или без него:
 * у второго варианта браузер подставляет свои 300×150, и сравнивать надо
 * не их.
 */
function svgPair(size) {
  const box = size ? ' width="200" height="300"' : '';
  const svg = (color) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"${box}>` +
    '<rect width="200" height="300" fill="#0d1117"/>' +
    `<rect x="20" y="140" width="90" height="20" fill="${color}"/></svg>`;
  return { before: svg('#c9d1d9'), after: svg('#f85149') };
}

/**
 * Пара с двумя правками в разных концах кадра: вверху и внизу.
 * Общий прямоугольник для такой пары — почти весь кадр, и обрезка по нему
 * бессмысленна; ради этого случая и считаются отдельные места.
 */
function svgTwoSpots() {
  const frame = (top, bottom) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" width="200" height="300">' +
    '<rect width="200" height="300" fill="#0d1117"/>' +
    `<rect x="20" y="20" width="60" height="20" fill="${top}"/>` +
    `<rect x="110" y="250" width="80" height="34" fill="${bottom}"/></svg>`;
  return { before: frame('#c9d1d9', '#c9d1d9'), after: frame('#f85149', '#f85149') };
}

/** Вектор заданного размера с полоской посередине. */
function svgSized(width, height) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#0d1117"/>` +
    `<rect x="10" y="${Math.round(height / 2)}" width="40" height="8" fill="#c9d1d9"/></svg>`
  );
}

/**
 * Подкладывает то, что расширение получает от браузера: тексты, адреса своих
 * файлов и хранилище. Хранилище держим на стороне теста — настоящее переживает
 * перезагрузку страницы, и заглушка должна вести себя так же.
 */
async function stubExtension(page, settings = {}) {
  // Хранилище расширения: живёт в тесте, поэтому переживает page.reload().
  const store = {};
  await page.exposeFunction('ghpdStorageGet', (defaults) => ({ ...defaults, ...store }));
  await page.exposeFunction('ghpdStorageSet', (values) => {
    Object.assign(store, values);
  });

  await page.addInitScript((values) => {
    // @ts-ignore — настройка приходит из окна расширения.
    globalThis.storedSettings = values;
  }, settings);

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
    // Сколько потоков завели — по этому видно, каким путём пошло сравнение.
    // @ts-ignore
    globalThis.workersStarted = 0;
    const Original = Worker;
    // @ts-ignore
    globalThis.Worker = class extends Original {
      constructor(...args) {
        // @ts-ignore
        globalThis.workersStarted++;
        super(...args);
      }
    };

    // @ts-ignore — заглушка того куска API, которым пользуется расширение.
    globalThis.chrome = {
      i18n: { getMessage, getUILanguage: () => 'en' },
      runtime: { getURL: (path) => `${location.origin}/__ext/${path}` },
      storage: {
        sync: {
          // @ts-ignore
          get: async (defaults) => ({ ...defaults, ...globalThis.storedSettings }),
        },
        // Настройки панели живут здесь: во фрейме Safari своё хранилище
        // эфемерное, поэтому расширение держит их у себя. Само хранилище — на
        // стороне теста, чтобы переживать перезагрузку страницы, как настоящее.
        local: {
          // @ts-ignore
          get: (defaults) => globalThis.ghpdStorageGet(defaults),
          // @ts-ignore
          set: (values) => globalThis.ghpdStorageSet(values),
        },
        onChanged: { addListener: () => {} },
      },
    };
  }, messages);

  return store;
}

/** Открывает заглушку фрейма с подменённой сетью и готовым API расширения. */
async function openFrame(page, images = null, settings = {}, options = {}) {
  await page.route('https://viewscreen.githubusercontent.com/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('fixtures/frame.html') }),
  );
  // raw.githubusercontent.com отдаёт картинки с доступом отовсюду — без этого
  // холст стал бы «грязным» и прочитать его было бы нельзя.
  for (const [url, name] of [[BEFORE, 'before.png'], [AFTER, 'after.png']]) {
    await page.route(url, async (route) => {
      // Задержка нужна, чтобы успеть подёргать панель, пока идёт загрузка.
      if (options.slow) await new Promise((done) => setTimeout(done, options.slow));
      if (options.brokenImages) return route.abort();
      return route.fulfill({
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' },
        body: read(`fixtures/${name}`),
      });
    });
  }
  if (images) {
    for (const [url, body] of [[BEFORE_SVG, images.before], [AFTER_SVG, images.after]]) {
      await page.route(url, (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          headers: { 'access-control-allow-origin': '*' },
          body,
        }),
      );
    }
  }

  // Файлы расширения: расширение читает их через fetch и собирает из них
  // поток сравнения. Отдаём их с того же адреса, что и фрейм.
  await page.route('https://viewscreen.githubusercontent.com/__ext/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/__ext/', '');
    return route.fulfill({ contentType: 'text/javascript', body: read(`../src/${path}`) });
  });

  const store = await stubExtension(page, settings);

  // Позже общего маршрута на файлы расширения: побеждает последний.
  if (options.brokenWorker) {
    await page.route('**/__ext/content/worker.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("boom");' }),
    );
  }

  await page.goto(images ? FRAME_URL_SVG : FRAME_URL);
  return store;
}

/**
 * Догружает расширение в открытую страницу — как это делает браузер.
 * Состав и порядок берём из манифеста: список, переписанный руками,рано или
 * поздно разойдётся с тем, что грузит браузер, и тесты начнут проверять не то.
 */
const contentScripts = JSON.parse(read('../src/manifest.json')).content_scripts[0];

async function injectExtension(page) {
  for (const style of contentScripts.css) {
    // Ставим стиль первым, как это делает браузер: CSS расширения приходит
    // раньше страничного, поэтому при равной силе побеждает страница. Иначе
    // тест не увидит, как чужие правила перебивают наши.
    const css = readFileSync(file(`../src/${style}`), 'utf8');
    await page.evaluate((text) => {
      const node = document.createElement('style');
      node.textContent = text;
      document.head.prepend(node);
    }, css);
  }
  for (const script of contentScripts.js) {
    await page.addScriptTag({ path: file(`../src/${script}`) });
  }
}

/** Сколько на холсте пикселей цвета обводки. */
const outlinePixels = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('.ghpd-canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let found = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Янтарный — цвет рамки. Красный и синий не годятся: ими покрашено
      // само изменение, и считать их значит считать находку вместо указателя.
      if (data[i] === 191 && data[i + 1] === 135 && data[i + 2] === 0) found++;
    }
    return found;
  });

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
    // Нижняя граница содержимого — последний видимый элемент панели, а не
    // ползунок: под ним есть ещё переключатель кадров.
    const last = [...document.querySelectorAll('.ghpd-view > *')]
      .filter((node) => !node.hidden)
      .pop()
      .getBoundingClientRect();
    return { top: canvas.top - view.top, bottom: view.bottom - last.bottom };
  });

  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThan(24);
});

test('рамка облегает кадр вплотную', async ({ page }) => {
  // Высокая картинка ужимается ограничением по высоте, а рамка вокруг неё
  // раньше жила на отдельной обёртке и мерила ширину по натуральному размеру
  // кадра — справа от картинки внутри рамки оставалась пустая полоса.
  await page.setViewportSize({ width: 900, height: 500 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const framed = await page.evaluate(() => {
    const canvas = document.querySelector('.ghpd-canvas').getBoundingClientRect();
    // Всё, что обрамляет кадр, должно совпадать с ним по размеру. Кнопки со
    // своими рамками сюда не относятся — берём только предков холста и его
    // самого.
    const canvasNode = document.querySelector('.ghpd-canvas');
    return [...document.querySelectorAll('.ghpd-view, .ghpd-view *')]
      .filter((node) => node === canvasNode || node.contains(canvasNode))
      .filter((node) => parseFloat(getComputedStyle(node).borderTopWidth) > 0)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          className: node.className,
          extraWidth: Math.round(rect.width - canvas.width),
          extraHeight: Math.round(rect.height - canvas.height),
        };
      });
  });

  expect(framed.length).toBeGreaterThan(0);
  for (const box of framed) {
    expect(box, box.className).toMatchObject({ extraWidth: 0, extraHeight: 0 });
  }

  // И сама коробка холста совпадает с картинкой: если браузер растянет её по
  // одной стороне, object-fit впишет кадр по другой — и внутри рамки появится
  // пустая полоса.
  const fit = await page.evaluate(() => {
    const canvas = document.querySelector('.ghpd-canvas');
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    return {
      slackWidth: Math.round(rect.width - canvas.width * scale),
      slackHeight: Math.round(rect.height - canvas.height * scale),
    };
  });

  // Два пикселя — рамка.
  expect(fit.slackWidth).toBeLessThanOrEqual(2);
  expect(fit.slackHeight).toBeLessThanOrEqual(2);
});

test('в полном кадре изменения обведены', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-crop-toggle');

  // Кадр целиком показывается уменьшенным, и несколько пикселей на нём не
  // разглядеть — поэтому место правки обводится красным.
  expect(await outlinePixels(page)).toBeGreaterThan(0);
});

test('рамку вокруг изменений можно убрать', async ({ page }) => {
  const store = await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-crop-toggle');

  expect(await outlinePixels(page)).toBeGreaterThan(0);

  await page.click('.ghpd-outline-toggle');
  expect(await outlinePixels(page)).toBe(0);

  // Выбор запоминается — как и порог.
  expect(store['ghpd:outline']).toBe('off');
  await page.reload();
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-crop-toggle');
  expect(await outlinePixels(page)).toBe(0);
});

test('помнит выбранный режим на следующей картинке', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  // Следующий файл в пул-реквесте — это новый фрейм с тем же расширением.
  await page.reload();
  await injectExtension(page);
  await waitForResult(page);

  expect(await page.isChecked('.ghpd-mode-item input')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.classList.contains('ghpd-active')))
    .toBe(true);

  // Уход на родной режим отменяет запоминание — дальше решает GitHub.
  await page.click('.js-view-modes .js-view-mode-item:nth-child(1)');
  await page.reload();
  await injectExtension(page);

  expect(await page.isChecked('.ghpd-mode-item input')).toBe(false);
});

test('ползунок слушается клавиатуры и помнит порог', async ({ page }) => {
  const store = await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  await page.focus('.ghpd-slider');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  expect(await page.inputValue('.ghpd-slider')).toBe('0.12');
  expect(store['ghpd:threshold']).toBe('0.12');

  // Порог переживает переход к следующей картинке — фрейм там новый.
  await page.reload();
  await injectExtension(page);
  expect(await page.inputValue('.ghpd-slider')).toBe('0.12');
});

test('вектор сравнивается в разумном размере', async ({ page }) => {
  await openFrame(page, svgPair(true));
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const state = await page.evaluate(() => {
    const canvas = document.querySelector('.ghpd-canvas');
    return { meta: document.querySelector('.ghpd-meta').textContent, width: canvas.width };
  });

  // 200×300 при цели в 1024 по длинной стороне — увеличение втрое.
  expect(state.meta).toContain('vector rendered at 600×900');
  expect(state.meta).toMatch(/^[\d,]+ pixels/);
});

test('вектор без собственного размера тоже сравнивается', async ({ page }) => {
  // Без width и height браузер отдаёт свои 300×150 — сравнение по ним
  // показывало бы разницу в картинке, которой никто не видел.
  await openFrame(page, svgPair(false));
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const meta = await page.textContent('.ghpd-meta');

  expect(meta).toContain('vector rendered at');
  expect(Number(meta.match(/^([\d,]+) pixels/)[1].replace(/,/g, ''))).toBeGreaterThan(100);
});

test('считает в отдельном потоке', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  expect(await page.evaluate(() => globalThis.workersStarted)).toBe(1);

  // Смена порога идёт туда же и не заводит второго потока.
  await page.focus('.ghpd-slider');
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.ghpd-meta').textContent))
    .toMatch(/pixels/);

  expect(await page.evaluate(() => globalThis.workersStarted)).toBe(1);
});

test('без отдельного потока считает сам', async ({ page }) => {
  // Blob-потоки может запретить политика страницы, а в Safari расширение
  // порой поднимается без runtime — тогда остаётся общий поток.
  await openFrame(page);
  await page.evaluate(() => {
    delete globalThis.chrome.runtime;
  });
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  expect(await page.evaluate(() => globalThis.workersStarted)).toBe(0);
  expect(await page.textContent('.ghpd-meta')).toMatch(/^[\d,]+ pixels/);
});

test('переключает «до», «после» и разницу', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-crop-toggle');

  // Цвет полоски, которая и отличается: в «до» серая, в «после» красная.
  const stripe = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.ghpd-canvas');
      const [r, g, b] = canvas.getContext('2d').getImageData(30, 605, 1, 1).data;
      return `${r},${g},${b}`;
    });

  await page.click('.ghpd-views .ghpd-view-button:nth-child(1)');
  expect(await stripe()).toBe('201,209,217');

  await page.click('.ghpd-views .ghpd-view-button:nth-child(2)');
  expect(await stripe()).toBe('248,81,73');

  await page.click('.ghpd-views .ghpd-view-button:nth-child(3)');
  expect(await page.evaluate(() =>
    document.querySelector('.ghpd-views .ghpd-view-button:nth-child(3)').classList.contains('selected'),
  )).toBe(true);

  expect(await page.evaluate(() =>
    [...document.querySelectorAll('.ghpd-views .ghpd-view-button')].map((n) => n.textContent),
  )).toEqual(['before', 'after', 'diff', 'overlay', '3-up']);
});

test('наложение показывает разницу поверх цветного «после»', async ({ page }) => {
  // Разница и наложение — одна маска на разной подложке. Проверяем именно
  // подложку: под разницей серый призрак «до», под наложением — «после» как
  // оно есть, и правку видно в настоящем окружении.
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-crop-toggle');

  // Точка вдали от изменений: там подложка видна в чистом виде.
  const pixel = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.ghpd-canvas');
      const [r, g, b] = canvas.getContext('2d').getImageData(5, 5, 1, 1).data;
      return [r, g, b];
    });

  await page.click('.ghpd-views .ghpd-view-button:nth-child(2)');
  const after = await pixel();

  await page.click('.ghpd-views .ghpd-view-button:nth-child(4)');
  expect(await pixel()).toEqual(after);

  await page.click('.ghpd-views .ghpd-view-button:nth-child(3)');
  const [r, g, b] = await pixel();
  // Под разницей — обесцвеченное и выбеленное «до»: серый, а не цвет кадра.
  expect(r).toBe(g);
  expect(g).toBe(b);
});

test('выбранный кадр помнится между картинками', async ({ page }) => {
  const store = await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-views .ghpd-view-button:nth-child(5)');

  expect(store['ghpd:frame']).toBe('triple');

  await page.reload();
  await injectExtension(page);
  await waitForResult(page);

  expect(await page.evaluate(() => !document.querySelector('.ghpd-triple').hidden)).toBe(true);
});

test('переключатель кадров можно выключить в настройках', async ({ page }) => {
  await openFrame(page, null, { showViews: false });
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  await expect
    .poll(() => page.evaluate(() => document.querySelector('.ghpd-views')?.hidden))
    .toBe(true);
});

test('движение ползунка во время загрузки не ломает сравнение', async ({ page }) => {
  // Загрузка идёт заметное время, а панель уже отзывчива: раньше второй вход
  // заводил второй поток и отдавал ему уже отданные буферы — вместо результата
  // в подписи появлялось «ArrayBuffer is already detached».
  await openFrame(page, null, {}, { slow: 1500 });
  await injectExtension(page);
  await page.click('.ghpd-mode-item');

  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const slider = document.querySelector('.ghpd-slider');
    slider.value = '0.3';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await waitForResult(page);
  const meta = await page.textContent('.ghpd-meta');

  expect(meta).not.toMatch(/Failed|detached/);
  expect(await page.evaluate(() => globalThis.workersStarted)).toBe(1);
});

test('упавший поток не подвешивает панель', async ({ page }) => {
  // Поток мог не подняться: неполный набор файлов, чужая политика, что угодно.
  // Картинки к этому моменту не должны быть отданы — иначе считать нечем.
  await openFrame(page, null, {}, { brokenWorker: true });
  await injectExtension(page);
  await page.click('.ghpd-mode-item');

  await waitForResult(page);

  expect(await page.textContent('.ghpd-meta')).toMatch(/^[\d,]+ pixels/);
  expect(await page.evaluate(() => document.documentElement.dataset.ghpdWorker)).toBe('off');
});

test('после ошибки загрузки можно попробовать снова', async ({ page }) => {
  await openFrame(page, null, {}, { brokenImages: true });
  await injectExtension(page);
  await page.click('.ghpd-mode-item');

  await expect
    .poll(() => page.textContent('.ghpd-meta'))
    .toMatch(/Failed: could not load/);

  // Сеть починилась — повторная попытка обязана взяться за дело заново.
  await page.unroute(BEFORE);
  await page.unroute(AFTER);
  for (const [url, name] of [[BEFORE, 'before.png'], [AFTER, 'after.png']]) {
    await page.route(url, (route) =>
      route.fulfill({
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' },
        body: read(`fixtures/${name}`),
      }),
    );
  }
  await page.evaluate(() => {
    const slider = document.querySelector('.ghpd-slider');
    slider.value = '0.2';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await waitForResult(page);
  expect(await page.textContent('.ghpd-meta')).toMatch(/^[\d,]+ pixels/);
});

test('настройки переживают запрет хранилища фрейма', async ({ page }) => {
  // Ровно случай Safari: viewscreen — третья сторона по отношению к github.com,
  // и WebKit делает такое хранилище эфемерным. Настройки обязаны жить у
  // расширения, а не во фрейме.
  const store = await openFrame(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('storage is blocked');
      },
    });
  });
  await page.reload();
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  await page.focus('.ghpd-slider');
  await page.keyboard.press('ArrowRight');
  expect(store['ghpd:threshold']).toBe('0.11');

  // И на следующей картинке всё на месте: режим и порог.
  await page.reload();
  await injectExtension(page);
  await waitForResult(page);

  expect(await page.isChecked('.ghpd-mode-item input')).toBe(true);
  expect(await page.inputValue('.ghpd-slider')).toBe('0.11');
});

test('берёт картинку из основного репозитория, когда форк удалён', async ({ page }) => {
  // Форк удалён, а коммит влит: GitHub оставляет в адресе фрейма ссылку на
  // форк и сам показывает «Invalid image source». Расширение подменяет
  // владельца на тот, что в параметре nwo.
  const forked = BEFORE.replace('/owner/repo/', '/gone-fork/repo/');
  const frameUrl =
    'https://viewscreen.githubusercontent.com/diff/img' +
    `?enc_url1=${hex(forked)}&enc_url2=${hex(AFTER)}&nwo=owner/repo&path=shot.png`;

  await page.route('https://viewscreen.githubusercontent.com/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('fixtures/frame.html') }),
  );
  // Адрес форка мёртв, адрес основного репозитория — жив.
  await page.route(forked, (route) => route.abort());
  for (const [url, name] of [[BEFORE, 'before.png'], [AFTER, 'after.png']]) {
    await page.route(url, (route) =>
      route.fulfill({
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' },
        body: read(`fixtures/${name}`),
      }),
    );
  }
  await page.route('https://viewscreen.githubusercontent.com/__ext/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/__ext/', '');
    return route.fulfill({ contentType: 'text/javascript', body: read(`../src/${path}`) });
  });
  await stubExtension(page);
  await page.goto(frameUrl);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  expect(await page.textContent('.ghpd-meta')).toMatch(/^[\d,]+ pixels/);
});

test('разные размеры «до» и «после» не ломают сравнение', async ({ page }) => {
  // Снимок страницы вырос по высоте — самый частый случай в скриншотных
  // тестах. Кадры выравниваются по левому верхнему углу, а изменение размера
  // попадает в подпись.
  const tall = svgSized(200, 300);
  const taller = svgSized(200, 400);
  await openFrame(page, { before: tall, after: taller });
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const meta = await page.textContent('.ghpd-meta');

  expect(meta).toContain('size changed: 200×300 → 200×400');
  expect(meta).toMatch(/^[\d,]+ pixels/);
});

test('картинка нулевого размера — внятное сообщение', async ({ page }) => {
  const empty = '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>';
  await openFrame(page, { before: empty, after: empty });
  await injectExtension(page);
  await page.click('.ghpd-mode-item');

  await expect.poll(() => page.textContent('.ghpd-meta')).toBe('Failed: the image has no size');
});

test('совпадающие картинки — ноль, а не «меньше сотой»', async ({ page }) => {
  const same = svgSized(80, 80);
  await openFrame(page, { before: same, after: same });
  await injectExtension(page);
  await page.click('.ghpd-mode-item');

  await expect.poll(() => page.textContent('.ghpd-meta')).toContain('0 pixels · 0% of the frame');
});

test('три кадра рядом влезают по ширине', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  // Второй наш пункт в ряду — три кадра рядом.
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-views .ghpd-view-button:nth-child(5)');

  const layout = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('.ghpd-triple .ghpd-canvas')];
    const view = document.querySelector('.ghpd-view').getBoundingClientRect();
    const boxes = canvases.map((node) => node.getBoundingClientRect());
    return {
      сколько: canvases.length,
      одиночныйСпрятан: document.querySelector('.ghpd-view > .ghpd-shell > .ghpd-canvas').hidden,
      // Переключатель остаётся на месте: это он и переключил.
      переключательВиден: !document.querySelector('.ghpd-views').hidden,
      влезают: boxes.every((box) => box.left >= view.left - 1 && box.right <= view.right + 1),
      // Все три одного размера: сравнивать глазами иначе невозможно.
      ширины: boxes.map((box) => Math.round(box.width)),
      подписи: [...document.querySelectorAll('.ghpd-triple-label')].map((n) => n.textContent),
    };
  });

  expect(layout.сколько).toBe(3);
  expect(layout.одиночныйСпрятан).toBe(true);
  expect(layout.переключательВиден).toBe(true);
  expect(layout.влезают).toBe(true);
  expect(new Set(layout.ширины).size).toBe(1);
  expect(layout.подписи).toEqual(['before', 'after', 'diff']);
});

test('три кадра показывают разные картинки', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-crop-toggle');
  await page.click('.ghpd-views .ghpd-view-button:nth-child(5)');

  // Полоска, которая и отличается: в «до» серая, в «после» красная.
  const colors = await page.evaluate(() =>
    [...document.querySelectorAll('.ghpd-triple .ghpd-canvas')].map((canvas) => {
      const [r, g, b] = canvas.getContext('2d').getImageData(30, 605, 1, 1).data;
      return `${r},${g},${b}`;
    }),
  );

  expect(colors[0]).toBe('201,209,217');
  expect(colors[1]).toBe('248,81,73');
  expect(colors[2]).not.toBe(colors[0]);
});

/** Одиночный кадр панели — тот, который увеличивают. */
const FRAME_CANVAS = '.ghpd-view > .ghpd-shell > .ghpd-canvas';

/** Что сейчас на холсте: размер, угловой пиксель и отпечаток содержимого. */
const canvasState = (page) =>
  page.evaluate((selector) => {
    const canvas = document.querySelector(selector);
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum = (sum * 31 + data[i] + data[i + 1] * 3) % 1e9;
    return {
      ширина: canvas.width,
      высота: canvas.height,
      угол: [...data.slice(0, 3)].join(','),
      отпечаток: sum,
    };
  }, FRAME_CANVAS);

/** Колесо над кадром: с Ctrl — увеличение, без него — обычная прокрутка. */
const wheelOver = (page, { ctrl, deltaY, at = 'corner' }) =>
  page.evaluate(
    ({ selector, ctrl, deltaY, at }) => {
      const canvas = document.querySelector(selector);
      const box = canvas.getBoundingClientRect();
      const event = new WheelEvent('wheel', {
        clientX: at === 'corner' ? box.left + 1 : box.left + box.width / 2,
        clientY: at === 'corner' ? box.top + 1 : box.top + box.height / 2,
        deltaY,
        ctrlKey: ctrl,
        bubbles: true,
        cancelable: true,
      });
      canvas.dispatchEvent(event);
      // Отменённое событие — то, которое мы забрали себе у прокрутки.
      return event.defaultPrevented;
    },
    { selector: FRAME_CANVAS, ctrl, deltaY, at },
  );

test('щипок увеличивает кадр, а обычная прокрутка остаётся прокруткой', async ({ page }) => {
  // Щипок на трекпаде приходит в браузер колесом с Ctrl — им и увеличиваем.
  // Простое колесо принадлежит странице: кадр живёт посреди неё, и отнимать
  // у человека прокрутку ради увеличения нечестно.
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const было = await canvasState(page);

  expect(await wheelOver(page, { ctrl: false, deltaY: -300 })).toBe(false);
  expect(await canvasState(page)).toEqual(было);
  expect(await page.textContent('.ghpd-meta')).not.toContain('zoom');

  expect(await wheelOver(page, { ctrl: true, deltaY: -300 })).toBe(true);
  const стало = await canvasState(page);

  expect(стало.отпечаток).not.toBe(было.отпечаток);
  expect(await page.textContent('.ghpd-meta')).toContain('zoom');
});

test('увеличение не меняет размер холста, а только то, что в нём', async ({ page }) => {
  // Размер холста — это размер коробки на экране: браузер берёт его из
  // пикселей. Уменьшив холст ради увеличения, мы съёжили бы картинку вместо
  // того, чтобы её приблизить.
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const было = await canvasState(page);
  await wheelOver(page, { ctrl: true, deltaY: -600 });
  const стало = await canvasState(page);

  expect(стало.ширина).toBe(было.ширина);
  expect(стало.высота).toBe(было.высота);
  // Увеличивали от левого верхнего угла — он и остаётся на месте.
  expect(стало.угол).toBe(было.угол);
});

test('кадр можно тянуть, а двойной щелчок возвращает как было', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const было = await canvasState(page);
  await wheelOver(page, { ctrl: true, deltaY: -600, at: 'centre' });
  const увеличено = await canvasState(page);

  const box = await page.locator(FRAME_CANVAS).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 4 });
  await page.mouse.up();

  const сдвинуто = await canvasState(page);
  expect(сдвинуто.отпечаток).not.toBe(увеличено.отпечаток);
  expect(await page.locator(FRAME_CANVAS).getAttribute('class')).toContain('ghpd-zoomed');

  await page.dblclick(FRAME_CANVAS);

  expect(await canvasState(page)).toEqual(было);
  expect(await page.textContent('.ghpd-meta')).not.toContain('zoom');
});

test('увеличение работает с клавиатуры, и сброс есть в подписи', async ({ page }) => {
  // Мышь есть не у всех: увеличение, доступное только колесом, — это
  // увеличение, которого нет у тех, кому оно нужнее всего.
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const было = await canvasState(page);
  await page.focus(FRAME_CANVAS);
  for (let i = 0; i < 4; i++) await page.keyboard.press('+');

  expect((await canvasState(page)).отпечаток).not.toBe(было.отпечаток);

  const увеличено = await canvasState(page);
  await page.keyboard.press('ArrowRight');

  expect((await canvasState(page)).отпечаток).not.toBe(увеличено.отпечаток);

  await page.click('.ghpd-zoom-reset');

  expect(await canvasState(page)).toEqual(было);
});

test('по двум правкам в разных концах кадра можно ходить', async ({ page }) => {
  // Пока правка одна, обрезка по ней и есть ответ. Когда их две, общий
  // прямоугольник растягивается на весь кадр — и обрезка перестаёт что-либо
  // показывать. Поэтому обрезаем по выбранному месту, а между местами ходим.
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page, svgTwoSpots());
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  await expect(page.locator('.ghpd-meta')).toContainText('change 1 of 2');
  const первое = await canvasState(page);

  await page.click('.ghpd-cluster-step[aria-label="next change"]');

  await expect(page.locator('.ghpd-meta')).toContainText('change 2 of 2');
  const второе = await canvasState(page);
  expect(второе.отпечаток).not.toBe(первое.отпечаток);

  // Ходим по кругу: после последнего — снова первое.
  await page.click('.ghpd-cluster-step[aria-label="next change"]');

  await expect(page.locator('.ghpd-meta')).toContainText('change 1 of 2');
  expect(await canvasState(page)).toEqual(первое);

  // И назад — тоже по кругу.
  await page.click('.ghpd-cluster-step[aria-label="previous change"]');

  await expect(page.locator('.ghpd-meta')).toContainText('change 2 of 2');
});

test('в полном кадре обведены все места, а не только выбранное', async ({ page }) => {
  // Переход «дальше» уводит туда, где на кадре ничего не отмечено, — если
  // обвести только выбранное место. Поэтому обводим все, выбранное ярче.
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page, svgTwoSpots());
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-crop-toggle');

  const половины = await page.evaluate((selector) => {
    const canvas = document.querySelector(selector);
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const found = { верх: 0, низ: 0 };
    for (let i = 0; i < data.length; i += 4) {
      // Янтарный узнаём по порядку составляющих: красного больше зелёного,
      // зелёного больше синего. Так он узнаётся и бледным — рамки вокруг
      // невыбранных мест рисуются полупрозрачными. Цвета самой разницы этому
      // не отвечают: у красного (209, 36, 47) зелёного меньше, чем синего.
      if (data[i] > data[i + 1] && data[i + 1] > data[i + 2] && data[i] - data[i + 2] > 40) {
        const y = Math.floor(i / 4 / canvas.width);
        if (y < canvas.height / 2) found.верх++;
        else found.низ++;
      }
    }
    return found;
  }, FRAME_CANVAS);

  expect(половины.верх).toBeGreaterThan(0);
  expect(половины.низ).toBeGreaterThan(0);
});

test('одна правка — переходов нет', async ({ page }) => {
  // Стрелки «‹ 1 из 1 ›» никуда не ведут и только занимают место в подписи.
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  await expect(page.locator('.ghpd-cluster-step')).toHaveCount(0);
});

test('показанный кадр сохраняется картинкой', async ({ page }) => {
  // Сохраняется именно то, что на экране: выбранный кадр, обрезка, увеличение.
  // Имя файла — от имени картинки, чтобы в папке загрузок было видно, откуда
  // это и что именно на нём.
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('.ghpd-save'),
  ]);

  expect(download.suggestedFilename()).toBe('shot.diff.png');

  // Файл должен быть настоящим PNG, а не пустышкой: подпись формата стоит
  // в первых восьми байтах.
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);

  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  // Размер записан в заголовке PNG — сверяем с холстом: так видно, что
  // сохранился показанный кадр, а не что-нибудь другое.
  const холст = await page.evaluate(
    (selector) => {
      const node = document.querySelector(selector);
      return { ширина: node.width, высота: node.height };
    },
    FRAME_CANVAS,
  );

  expect(bytes.readUInt32BE(16)).toBe(холст.ширина);
  expect(bytes.readUInt32BE(20)).toBe(холст.высота);
});

test('имя файла говорит, какой кадр сохранён', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  // Второй кадр переключателя — «после».
  await page.click('.ghpd-views .ghpd-view-button:nth-child(2)');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('.ghpd-save'),
  ]);

  expect(download.suggestedFilename()).toBe('shot.after.png');
});

test('три кадра рядом не сохраняются одной картинкой', async ({ page }) => {
  // Их три холста, и «эта картинка» перестаёт быть одной картинкой: кнопка
  // обещала бы то, чего сделать не может.
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);
  await page.click('.ghpd-views .ghpd-view-button:nth-child(5)');

  await expect(page.locator('.ghpd-save')).toHaveCount(0);
});

test('запомненный режим ждёт, пока фрейм вырастет', async ({ page }) => {
  // Высоту фрейма задаёт родительская страница, и делает это, когда меняется
  // её собственный режим. Восстановишь свой раньше — окно внутри остаётся
  // полоской, и кадр ужимается в точку: режим выбран, а показывать нечего.
  await page.setViewportSize({ width: 900, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  // Следующая картинка открывается в ещё не выросшем фрейме.
  await page.setViewportSize({ width: 900, height: 150 });
  await page.reload();
  await injectExtension(page);
  await page.waitForSelector('.ghpd-mode-item');

  expect(await page.isChecked('.ghpd-mode-item input[value="pixel-diff"]')).toBe(false);

  // Фрейм вырос — вот теперь можно.
  await page.setViewportSize({ width: 900, height: 700 });
  await waitForResult(page);

  const canvas = await page.evaluate(() => {
    const node = document.querySelector('.ghpd-view > .ghpd-shell > .ghpd-canvas');
    const box = node.getBoundingClientRect();
    // Сравниваем с самим кадром: в точку он ужимается, когда фрейм — полоска.
    return { доляВысоты: box.height / node.height, доляШирины: box.width / node.width };
  });

  expect(await page.isChecked('.ghpd-mode-item input[value="pixel-diff"]')).toBe(true);
  expect(canvas.доляВысоты).toBeGreaterThan(0.9);
  expect(canvas.доляШирины).toBeGreaterThan(0.9);
});

test('кадр по центру, даже если подпись шире', async ({ page }) => {
  // Подпись бывает длинной: обрезка плюс изменение размера. Кадр обязан
  // остаться по центру, а не прижаться к её левому краю.
  await page.setViewportSize({ width: 1200, height: 700 });
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const centers = await page.evaluate(() => {
    document.querySelector('.ghpd-meta').append(
      ' · размер изменился: 375×849 → 375×861 и ещё немного текста для длины',
    );
    const middle = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return box.left + box.width / 2;
    };
    return {
      вид: middle('.ghpd-view'),
      холст: middle('.ghpd-view > .ghpd-shell > .ghpd-canvas'),
      подпись: middle('.ghpd-meta'),
    };
  });

  expect(Math.abs(centers.холст - centers.вид)).toBeLessThan(2);
  expect(Math.abs(centers.подпись - centers.вид)).toBeLessThan(2);
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
