// @ts-check
// Проверка на живой странице GitHub: разметку панели просмотра там меняют без
// предупреждений, и этот тест — единственный способ узнать об этом вовремя.
//
// Работаем через evaluate, а не через локаторы: страница живёт своей жизнью,
// фрейм может перерисоваться, и снимок состояния надёжнее ожидания на узле.
import { test, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSION = fileURLToPath(new URL('../dist/chrome', import.meta.url));
// Свой пул-реквест-полигон: одна изменённая картинка, живёт столько же,
// сколько репозиторий.
const PULL_REQUEST = 'https://github.com/Nemo-Illusionist/gh-pixel-diff/pull/1/files';

const isViewscreen = (url) => url.includes('viewscreen.githubusercontent.com/diff/img');

/** Снимок состояния панели внутри фрейма. */
function readState() {
  const canvas = document.querySelector('.ghpd-canvas');
  const view = document.querySelector('.ghpd-view');
  return {
    modes: document.querySelectorAll('.js-view-mode-item').length,
    ours: document.querySelectorAll('.ghpd-mode-item').length,
    checked: document.querySelector('.ghpd-mode-item input[value="pixel-diff"]')?.checked ?? false,
    meta: document.querySelector('.ghpd-meta')?.textContent ?? '',
    canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
    viewHidden: view ? view.hidden : null,
    nativeHidden: [...document.querySelectorAll('.view:not(.ghpd-view)')]
      .every((v) => getComputedStyle(v).visibility === 'hidden'),
    // Родных режимов одновременно виден ровно один — тот, что выбран.
    nativeVisible: [...document.querySelectorAll('.view:not(.ghpd-view)')]
      .filter((v) => getComputedStyle(v).display !== 'none'
        && getComputedStyle(v).visibility !== 'hidden').length,
    slider: !!document.querySelector('.ghpd-controls input.ghpd-slider'),
    // Сравнение уходит в отдельный поток: на настоящей странице это зависит
    // от доступа к файлам расширения, а его даёт только манифест.
    worker: document.documentElement.dataset.ghpdWorker ?? null,
  };
}

test('добавляет режим к родным и считает разницу', async () => {
  test.setTimeout(120_000);

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

    // Фрейм берём заново на каждом шаге: GitHub пересоздаёт его при перерисовке.
    const frame = () => page.frames().find((f) => isViewscreen(f.url()));
    const state = async () => {
      const current = frame();
      if (!current) return null;
      return current.evaluate(readState).catch(() => null);
    };

    // Наш режим встал рядом с тремя родными, ровно один.
    await expect.poll(state, { timeout: 60_000 }).toMatchObject({ modes: 4, ours: 1 });

    await frame().evaluate(() => {
      document.querySelector('.ghpd-mode-item input[value="pixel-diff"]').click();
    });

    await expect.poll(state, { timeout: 60_000 }).toMatchObject({
      checked: true,
      viewHidden: false,
      // Родные режимы на это время спрятаны, ползунок порога — на месте.
      nativeHidden: true,
      slider: true,
    });

    // Расчёт занимает заметное время: снимок делаем, когда он закончен.
    // Язык подписи — язык браузера, поэтому проверяем оба: русское склонение
    // числа и английское множественное.
    await expect
      .poll(async () => (await state())?.meta ?? '', { timeout: 60_000 })
      .toMatch(/\d+ (пиксел(ь|я|ей)|pixels?)/);

    const done = await state();
    expect(done.worker).toBe('on');
    expect(done.meta).not.toMatch(/Не вышло|Failed/);
    // По умолчанию показан фрагмент с изменениями, а не весь кадр.
    expect(done.meta).toMatch(/фрагмент|fragment/);
    expect(Number(done.meta.replace(/\s/g, '').match(/^(\d+)/)?.[1])).toBeGreaterThan(100);
    expect(done.canvas).toMatch(/^\d+x\d+$/);

    // Возврат к родному режиму возвращает всё как было.
    await frame().evaluate(() => {
      document.querySelector('.js-view-mode-item input[value="two-up"]').click();
    });
    await expect.poll(state, { timeout: 30_000 }).toMatchObject({
      checked: false,
      viewHidden: true,
      nativeHidden: false,
      nativeVisible: 1,
    });
  } finally {
    await context.close();
  }
});
