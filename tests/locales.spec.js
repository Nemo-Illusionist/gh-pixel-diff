// @ts-check
// Полнота локалей: код просит строку по ключу, и если ключа нет — вместо
// текста подставится пустота. Молча, во всех браузерах, только на одном языке.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const read = (path) => readFileSync(file(path), 'utf8');

const locales = Object.fromEntries(
  readdirSync(file('../src/_locales')).map((name) => [
    name,
    JSON.parse(read(`../src/_locales/${name}/messages.json`)),
  ]),
);

/** Ключи, которые код просит у локали. */
function requestedKeys() {
  const keys = new Set();
  const sources = [
    ...readdirSync(file('../src/content')).map((name) => read(`../src/content/${name}`)),
    read('../src/popup/popup.js'),
  ].join('\n');

  for (const [, key] of sources.matchAll(/\bt\(\s*'([a-zA-Z]+)'/g)) keys.add(key);
  // Разметка окна просит строки атрибутами.
  for (const [, key] of read('../src/popup/popup.html').matchAll(/data-i18n(?:-rich)?="([^"]+)"/g)) {
    keys.add(key);
  }
  // Формы множественного числа собираются из имени: у русского их больше.
  for (const [, key] of sources.matchAll(/\bplural\(\s*'([a-zA-Z]+)'/g)) {
    keys.add(`${key}One`);
    keys.add(`${key}Other`);
  }
  // Имена кадров тоже собираются из имени кнопки.
  for (const name of ['Before', 'After', 'Diff']) keys.add(`view${name}`);
  return keys;
}

test('в каждой локали есть всё, что просит код', () => {
  const requested = [...requestedKeys()].sort();

  for (const [name, messages] of Object.entries(locales)) {
    const missing = requested.filter((key) => !messages[key]);
    expect(missing, `нет в локали ${name}`).toEqual([]);
  }
});

test('локали не расходятся между собой', () => {
  const [first, ...rest] = Object.keys(locales);
  // Русский добавляет формы «few» и «many» — их в английском быть и не должно.
  const extra = /(?:Few|Many)$/;

  for (const other of rest) {
    const here = Object.keys(locales[first]).filter((key) => !extra.test(key)).sort();
    const there = Object.keys(locales[other]).filter((key) => !extra.test(key)).sort();
    expect(there, `${other} против ${first}`).toEqual(here);
  }
});

test('манифест ссылается на существующие строки', () => {
  const manifest = read('../src/manifest.json');

  for (const [, key] of manifest.matchAll(/__MSG_([a-zA-Z]+)__/g)) {
    for (const [name, messages] of Object.entries(locales)) {
      expect(messages[key], `${key} нет в локали ${name}`).toBeTruthy();
    }
  }
});
