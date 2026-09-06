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
    await page.addStyleTag({ path: file(`../src/${style}`) });
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
      if (data[i] === 209 && data[i + 1] === 36 && data[i + 2] === 47) found++;
    }
    return found;
  });

/** Ждёт, пока сравнение посчитается и подпись перестанет быть «Comparing…». */
async function waitForResult(page) {
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.ghpd-meta')?.textContent ?? ''))
    .toMatch(/pixels/);
}

test('встаёт двумя кнопками в родной ряд, родные не трогает', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);

  const modes = await page.evaluate(() =>
    [...document.querySelectorAll('.js-view-mode-item')].map((item) => ({
      text: item.textContent.trim(),
      ours: item.classList.contains('ghpd-mode-item'),
    })),
  );

  expect(modes.map((mode) => mode.text)).toEqual([
    '2-up', 'Swipe', 'Onion Skin', 'Pixel Diff', '3-up',
  ]);
  expect(modes.map((mode) => mode.ours)).toEqual([false, false, false, true, true]);
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
  await page.click('.js-view-modes .js-view-mode-item:nth-child(5)');
  await waitForResult(page);

  const layout = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('.ghpd-triple .ghpd-canvas')];
    const view = document.querySelector('.ghpd-view').getBoundingClientRect();
    const boxes = canvases.map((node) => node.getBoundingClientRect());
    return {
      сколько: canvases.length,
      одиночныйСпрятан: document.querySelector('.ghpd-view > .ghpd-shell > .ghpd-canvas').hidden,
      переключательСпрятан: document.querySelector('.ghpd-views').hidden,
      влезают: boxes.every((box) => box.left >= view.left - 1 && box.right <= view.right + 1),
      // Все три одного размера: сравнивать глазами иначе невозможно.
      ширины: boxes.map((box) => Math.round(box.width)),
      подписи: [...document.querySelectorAll('.ghpd-triple-label')].map((n) => n.textContent),
    };
  });

  expect(layout.сколько).toBe(3);
  expect(layout.одиночныйСпрятан).toBe(true);
  expect(layout.переключательСпрятан).toBe(true);
  expect(layout.влезают).toBe(true);
  expect(new Set(layout.ширины).size).toBe(1);
  expect(layout.подписи).toEqual(['before', 'after', 'diff']);
});

test('три кадра показывают разные картинки', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.js-view-modes .js-view-mode-item:nth-child(5)');
  await waitForResult(page);
  await page.click('.ghpd-crop-toggle');

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

test('подпись на языке интерфейса', async ({ page }) => {
  await openFrame(page);
  await injectExtension(page);
  await page.click('.ghpd-mode-item');
  await waitForResult(page);

  const meta = await page.textContent('.ghpd-meta');

  expect(meta).toMatch(/^[\d,]+ pixels · [\d.<]+% of the frame/);
  expect(meta).toContain('show the whole frame');
});
