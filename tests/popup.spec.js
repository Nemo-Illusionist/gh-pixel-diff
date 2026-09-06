// @ts-check
// Разбор разметки в переведённой строке.
//
// Строки с <b> и <code> собираются узлами, а не через innerHTML, и разбирает
// их свой десяток строк. Правит эти строки человек-переводчик, поэтому
// незакрытый или лишний тег — вопрос времени, а не гипотеза.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const popup = readFileSync(
  fileURLToPath(new URL('../src/popup/popup.js', import.meta.url)),
  'utf8',
);

// Берём из окна только разбор разметки: остальное завязано на API браузера.
const setRich = popup.slice(popup.indexOf('const TAGS'), popup.indexOf('for (const node of'));

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><title>fixture</title><p id="out"></p>');
  await page.addScriptTag({ content: `${setRich}\nwindow.setRich = setRich;` });
});

const render = (page, text) =>
  page.evaluate((value) => {
    const node = document.querySelector('#out');
    window.setRich(node, value);
    return { html: node.innerHTML, text: node.textContent };
  }, text);

test('собирает разметку узлами', async ({ page }) => {
  const result = await render(page, 'Adds a <b>Pixel Diff</b> mode to <code>github.com</code>.');

  expect(result.html).toBe('Adds a <b>Pixel Diff</b> mode to <code>github.com</code>.');
});

test('текст без разметки остаётся текстом', async ({ page }) => {
  const result = await render(page, 'Access granted — the mode will appear.');

  expect(result.html).toBe('Access granted — the mode will appear.');
});

test('незакрытый тег не съедает остаток фразы', async ({ page }) => {
  // Перевод правит человек; потеря половины предложения — не тот способ
  // сообщить ему об опечатке.
  const result = await render(page, 'Adds a <b>Pixel Diff mode to the viewer.');

  expect(result.text).toBe('Adds a <b>Pixel Diff mode to the viewer.');
});

test('чужой тег остаётся текстом, а не разметкой', async ({ page }) => {
  const result = await render(page, 'Nothing <img src=x onerror=alert(1)> here.');

  expect(result.html).toBe('Nothing &lt;img src=x onerror=alert(1)&gt; here.');
  expect(await page.evaluate(() => document.querySelectorAll('#out img').length)).toBe(0);
});
