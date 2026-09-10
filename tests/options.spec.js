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
