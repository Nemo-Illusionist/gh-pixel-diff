// @ts-check
// Проверка на живой странице GitHub: разметку diff-вью там меняют без
// предупреждений, и этот тест — единственный способ узнать об этом вовремя.
import { test, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSION = fileURLToPath(new URL('../dist/chrome', import.meta.url));
// Пул-реквест с пятнадцатью изменёнными снимками — удобный постоянный образец.
const PULL_REQUEST = 'https://github.com/DanilovSoft/DaniloFF/pull/2/files';

test('панель появляется у картинки и считает разницу', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'ghpd-'));
  // Расширения работают и в headless-режиме Chromium — отдельный экран не нужен.
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  try {
    const page = await context.newPage();
    await page.goto(PULL_REQUEST, { waitUntil: 'domcontentloaded' });

    const panel = page.locator('.ghpd-panel').first();
    await expect(panel).toBeVisible({ timeout: 30_000 });

    await panel.getByRole('button', { name: 'Пиксельная разница' }).click();

    const status = panel.locator('.ghpd-status');
    await expect(status).toContainText('пикселей', { timeout: 30_000 });
    await expect(status).not.toContainText('Не вышло');

    // Диффов должно быть заметно много: правки задели весь текст страницы.
    const changed = Number((await status.textContent()).replace(/\s/g, '').match(/^(\d+)/)?.[1]);
    expect(changed).toBeGreaterThan(100);

    // По умолчанию показывается фрагмент с изменениями, а не весь снимок.
    await expect(panel.locator('.ghpd-crop canvas')).toBeVisible();
    await expect(panel.locator('.ghpd-crop')).toContainText('уместились все различия');

    await panel.getByRole('button', { name: 'Разница целиком' }).click();
    await expect(panel.locator('canvas.ghpd-canvas')).toBeVisible();

    // Режимы переключаются.
    await panel.getByRole('button', { name: 'Рядом' }).click();
    await expect(panel.locator('.ghpd-side-img')).toHaveCount(2);
  } finally {
    await context.close();
  }
});
