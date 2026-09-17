// @ts-check
// Разбор адреса своего сервера GitLab.
//
// В эту строку люди приносят что угодно: адрес со схемой и без, со слэшем,
// с портом, целиком скопированный мердж-реквест. Ошибка здесь стоит дорого:
// разрешение выдаётся браузером на хост, и выдать его не тому — хуже, чем
// отказать.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const read = (path) => readFileSync(file(path), 'utf8');

const options = read('../src/options/options.js');
// Берём из страницы только разбор адреса: остальное завязано на API браузера.
const toOrigin = options.slice(options.indexOf('function toOrigin'), options.indexOf('/** Состав'));

const locales = ['en', 'ru'].map((name) => JSON.parse(read(`../src/_locales/${name}/messages.json`)));

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><title>fixture</title>');
  // Адреса, выданные при установке, нужны разбору: их он и отклоняет.
  await page.addScriptTag({
    content:
      "const ORIGINS = { origins: ['https://viewscreen.githubusercontent.com/*', 'https://gitlab.com/*'] };\n" +
      `${toOrigin}\nwindow.toOrigin = toOrigin;`,
  });
});

const parse = (page, value) => page.evaluate((raw) => window.toOrigin(raw), value);

test('голое имя хоста превращается в шаблон https', async ({ page }) => {
  expect(await parse(page, 'gitlab.example.com')).toEqual({
    host: 'gitlab.example.com',
    origin: 'https://gitlab.example.com/*',
  });
});

test('лишнее вокруг адреса отбрасывается', async ({ page }) => {
  for (const value of [
    '  gitlab.example.com  ',
    'https://gitlab.example.com',
    'https://gitlab.example.com/',
    'https://gitlab.example.com/owner/repo/-/merge_requests/1/diffs',
    // Порт в шаблонах разрешений не понимают, а доступ к хосту покрывает и его.
    'https://gitlab.example.com:8443/',
    'GitLab.Example.COM',
  ]) {
    expect(await parse(page, value), value).toEqual({
      host: 'gitlab.example.com',
      origin: 'https://gitlab.example.com/*',
    });
  }
});

test('http остаётся http: внутренние серверы бывают и такими', async ({ page }) => {
  expect(await parse(page, 'http://gitlab.internal')).toEqual({
    host: 'gitlab.internal',
    origin: 'http://gitlab.internal/*',
  });
});

test('мусор и шаблоны отклоняются', async ({ page }) => {
  for (const value of ['', '   ', '*', '*.example.com', 'https://*/*', 'не адрес', 'ftp://example.com']) {
    expect((await parse(page, value)).error, JSON.stringify(value)).toBe('optionsHostBad');
  }
});

test('уже выданные адреса добавлять незачем', async ({ page }) => {
  for (const value of ['gitlab.com', 'https://gitlab.com/owner/repo']) {
    expect((await parse(page, value)).error, value).toBe('optionsHostCovered');
  }
});

test('ключи отказов есть в локалях', () => {
  // Они приходят из разбора строкой, а не через t(): проверку полноты
  // локалей эти ключи иначе минуют.
  for (const messages of locales) {
    for (const key of ['optionsHostBad', 'optionsHostCovered']) {
      expect(messages[key], key).toBeTruthy();
    }
  }
});

// Переключатель языка на самой странице настроек.
//
// Проверяется целиком, с разметкой и хранилищем: страница не только меняет
// собственные надписи, но и раскладывает строки для панели сравнения — до
// файла локали та не дотянется, она живёт на чужой странице.
const SITE = 'https://options.test';

/** Открывает страницу настроек с заглушкой API браузера. */
async function openOptions(page) {
  await page.route(`${SITE}/**`, (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    const types = { js: 'text/javascript', css: 'text/css', html: 'text/html', json: 'application/json' };
    try {
      return route.fulfill({
        contentType: `${types[path.split('.').pop()] ?? 'text/plain'}; charset=utf-8`,
        body: readFileSync(file(`../src/${path}`)),
      });
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
  });

  await page.addInitScript((messages) => {
    const store = { sync: {}, local: {} };
    // @ts-ignore — видно тесту: страница должна не только показать язык, но и
    // положить строки для панели.
    globalThis.ghpdStore = store;
    const area = (name) => ({
      get: async (defaults) => ({ ...defaults, ...store[name] }),
      set: async (values) => Object.assign(store[name], values),
      remove: async (key) => {
        delete store[name][key];
      },
    });
    // @ts-ignore
    globalThis.chrome = {
      i18n: {
        getMessage: (key, substitutions = []) => {
          const entry = messages[key];
          if (!entry) return '';
          let text = entry.message;
          for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
            text = text.replaceAll(`$${name}$`, String(substitutions[Number(placeholder.content.slice(1)) - 1] ?? ''));
          }
          return text;
        },
        getUILanguage: () => 'en',
      },
      runtime: {
        getURL: (path) => `${location.origin}/${path}`,
        getManifest: () => ({ content_scripts: [{ matches: ['https://gitlab.com/*'], js: [], css: [] }] }),
      },
      storage: { sync: area('sync'), local: area('local') },
      permissions: {
        contains: async () => true,
        getAll: async () => ({ origins: [] }),
      },
    };
  }, locales[0]);

  await page.goto(`${SITE}/options/options.html`);
}

test('язык выбирается на странице настроек', async ({ page }) => {
  await openOptions(page);

  // Пока выбора нет, страница говорит на языке браузера.
  await expect(page.locator('#language')).toHaveValue('');
  await expect(page.locator('h2').first()).toHaveText('Language');

  await page.selectOption('#language', 'ru');

  await expect(page.locator('h2').first()).toHaveText('Язык');
  // «Как в браузере» тоже переводится, а имена языков — нет: их узнают на них
  // самих.
  await expect(page.locator('#language option').first()).toHaveText('как в браузере');
  await expect(page.locator('#language option').nth(2)).toHaveText('Русский');
  expect(await page.getAttribute('html', 'lang')).toBe('ru');
});

test('строки выбранного языка кладутся для панели сравнения', async ({ page }) => {
  // Панель сравнения живёт на чужой странице, и содержимое `_locales` ей
  // недоступно. Донести до неё язык может только хранилище.
  await openOptions(page);
  await page.selectOption('#language', 'ru');

  await expect
    .poll(() => page.evaluate(() => globalThis.ghpdStore.local['ghpd:messages']?.language))
    .toBe('ru');

  expect(await page.evaluate(() => globalThis.ghpdStore.sync['ghpd:language'])).toBe('ru');
  expect(
    await page.evaluate(() => globalThis.ghpdStore.local['ghpd:messages'].messages.viewDiff.message),
  ).toBe('разница');
});

test('возврат к языку браузера убирает и строки', async ({ page }) => {
  await openOptions(page);
  await page.selectOption('#language', 'ru');
  await expect(page.locator('h2').first()).toHaveText('Язык');

  await page.selectOption('#language', '');

  await expect(page.locator('h2').first()).toHaveText('Language');
  await expect
    .poll(() => page.evaluate(() => globalThis.ghpdStore.local['ghpd:messages'] ?? null))
    .toBeNull();
});


test('цвета разницы выбираются и возвращаются к обычным', async ({ page }) => {
  await openOptions(page);

  await page.fill('#color-darker', '#ff8800');
  await page.dispatchEvent('#color-darker', 'change');

  await expect
    .poll(() => page.evaluate(() => globalThis.ghpdStore.sync.colors?.darker))
    .toBe('#ff8800');

  await page.click('#colors-reset');

  await expect(page.locator('#color-darker')).toHaveValue('#d1242f');
  await expect
    .poll(() => page.evaluate(() => globalThis.ghpdStore.sync.colors?.darker))
    .toBe('#d1242f');
});
