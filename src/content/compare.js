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

  /**
   * Переписывает адрес картинки на другой репозиторий.
   * Нужно, когда пул-реквест пришёл из форка, а форк потом удалили: GitHub
   * оставляет в разметке ссылку на него и сам показывает «Invalid image
   * source», хотя коммит уже влит и лежит в основном репозитории.
   */
  function rewriteRepository(url, repository) {
    if (!repository) return null;
    const rewritten = url.replace(
      /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\//,
      `https://raw.githubusercontent.com/${repository.owner}/${repository.name}/`,
    );
    return rewritten === url ? null : rewritten;
  }

  /** Загружает картинку так, чтобы холст остался «чистым» и читаемым. */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      // Вне расширения текста для сообщения нет — тогда в ошибку идёт адрес.
      img.onerror = () => reject(new Error(global.GhPixelDiffI18n?.t('loadFailed', src) || src));
      img.src = src;
    });
  }

  /** Загрузка с запасным адресом в основном репозитории. */
  async function loadImageWithFallback(src, repository) {
    try {
      return await loadImage(src);
    } catch (error) {
      const fallback = rewriteRepository(src, repository);
      if (!fallback) throw error;
      return loadImage(fallback);
    }
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
   *
   * Читаем готовый дифф, а не исходные картинки: pixelmatch красит
   * изменившийся пиксель в чистый красный, а всё остальное — в серое
   * (у серого r = g = b, так что спутать нельзя). Значит, границы считаются
   * по тому же порогу, что и число пикселей, — и одним проходом вместо двух.
   */
  function boundsOfChanges(diff, width, height) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = row + x * 4;
        if (diff[i] === 255 && diff[i + 1] === 0 && diff[i + 2] === 0) {
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
   * Загружает обе версии и раскладывает их по холстам одного размера.
   * Отделено от сравнения намеренно: при движении ползунка порога меняется
   * только сравнение, а загрузка и декодирование — самая дорогая часть —
   * делаются один раз.
   * @returns {Promise<{width, height, before, after, dataBefore, dataAfter,
   *                    sizeChanged: boolean}>}
   */
  async function preparePair(pair, options = {}) {
    const [before, after] = await Promise.all([
      loadImageWithFallback(pair.before, options.repository),
      loadImageWithFallback(pair.after, options.repository),
    ]);

    const width = Math.max(before.naturalWidth, after.naturalWidth);
    const height = Math.max(before.naturalHeight, after.naturalHeight);

    return {
      width,
      height,
      before,
      after,
      dataBefore: toImageData(before, width, height),
      dataAfter: toImageData(after, width, height),
      sizeChanged:
        before.naturalWidth !== after.naturalWidth ||
        before.naturalHeight !== after.naturalHeight,
    };
  }

  /**
   * Сравнивает уже загруженную пару с заданным порогом.
   * @returns {{width, height, changed, ratio, bounds, diff: ImageData,
   *            before: HTMLImageElement, after: HTMLImageElement,
   *            sizeChanged: boolean}}
   */
  function diffPrepared(prepared, options = {}) {
    const { width, height } = prepared;
    const diff = new ImageData(width, height);

    const changed = global.pixelmatch(
      prepared.dataBefore.data,
      prepared.dataAfter.data,
      diff.data,
      width,
      height,
      {
        threshold: options.threshold ?? 0.1,
        includeAA: options.includeAA ?? false,
        alpha: options.alpha ?? 0.35,
      },
    );

    return {
      width,
      height,
      changed,
      ratio: changed / (width * height),
      bounds: boundsOfChanges(diff.data, width, height),
      diff,
      before: prepared.before,
      after: prepared.after,
      sizeChanged: prepared.sizeChanged,
    };
  }

  /** Загрузка и сравнение одним вызовом. */
  async function comparePair(pair, options = {}) {
    return diffPrepared(await preparePair(pair, options), options);
  }

  global.GhPixelDiff = {
    readImagePair,
    decodeHexUrl,
    comparePair,
    preparePair,
    diffPrepared,
    loadImage,
    rewriteRepository,
    boundsOfChanges,
    VIEWSCREEN_IMG,
  };
})(self);
