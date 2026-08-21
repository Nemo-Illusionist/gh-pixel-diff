// Чистая часть: разбор ссылок на картинки и само сравнение.
// Никакого DOM страницы GitHub — чтобы это можно было проверять тестами.
(function (global) {
  'use strict';

  /** Хост, на котором GitHub рендерит превью бинарных файлов. */
  const VIEWSCREEN_IMG = /^https:\/\/viewscreen\.githubusercontent\.com\/diff\/img/;

  /** GitHub кодирует адреса картинок шестнадцатеричной строкой. */
  function decodeHexUrl(hex) {
    if (!hex || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
    let out = '';
    for (let i = 0; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return /^https:\/\//.test(out) ? out : null;
  }

  /**
   * Достаёт из адреса iframe'а обе версии картинки.
   * @returns {{before: string, after: string, path: string|null}|null}
   */
  function readImagePair(iframeSrc) {
    if (!iframeSrc || !VIEWSCREEN_IMG.test(iframeSrc)) return null;
    let url;
    try {
      url = new URL(iframeSrc);
    } catch {
      return null;
    }
    const before = decodeHexUrl(url.searchParams.get('enc_url1'));
    const after = decodeHexUrl(url.searchParams.get('enc_url2'));
    if (!before || !after) return null;
    return { before, after, path: url.searchParams.get('path') };
  }

  /** Загружает картинку так, чтобы холст остался «чистым» и читаемым. */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`не удалось загрузить ${src}`));
      img.src = src;
    });
  }

  /**
   * Рисует картинку в левом верхнем углу холста заданного размера.
   * Разные размеры — обычное дело: страница стала длиннее, снимок вырос.
   */
  function toImageData(img, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, width, height);
  }

  /**
   * Прямоугольник, в который укладываются все различия.
   * Для длинного снимка страницы это главное: правка обычно занимает
   * несколько строк, а искать их глазами по трём тысячам пикселей высоты
   * никто не станет.
   */
  function boundsOfChanges(a, b, width, height) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = row + x * 4;
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /**
   * Сравнивает две картинки и возвращает данные для отрисовки.
   * @returns {Promise<{width, height, changed, ratio, diff: ImageData,
   *                    before: HTMLImageElement, after: HTMLImageElement,
   *                    sizeChanged: boolean}>}
   */
  async function comparePair(pair, options = {}) {
    const [before, after] = await Promise.all([loadImage(pair.before), loadImage(pair.after)]);

    const width = Math.max(before.naturalWidth, after.naturalWidth);
    const height = Math.max(before.naturalHeight, after.naturalHeight);
    const sizeChanged =
      before.naturalWidth !== after.naturalWidth || before.naturalHeight !== after.naturalHeight;

    const dataBefore = toImageData(before, width, height);
    const dataAfter = toImageData(after, width, height);
    const diff = new ImageData(width, height);

    const changed = global.pixelmatch(dataBefore.data, dataAfter.data, diff.data, width, height, {
      threshold: options.threshold ?? 0.1,
      includeAA: options.includeAA ?? false,
      alpha: options.alpha ?? 0.35,
    });

    return {
      width,
      height,
      changed,
      ratio: changed / (width * height),
      bounds: boundsOfChanges(dataBefore.data, dataAfter.data, width, height),
      diff,
      before,
      after,
      sizeChanged,
    };
  }

  global.GhPixelDiff = {
    readImagePair,
    decodeHexUrl,
    comparePair,
    loadImage,
    boundsOfChanges,
    VIEWSCREEN_IMG,
  };
})(self);
