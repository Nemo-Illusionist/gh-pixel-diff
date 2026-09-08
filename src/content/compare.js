// Чистая часть: разбор ссылок на картинки и само сравнение.
// Никакого DOM страницы GitHub — чтобы это можно было проверять тестами.
(function (global) {
  'use strict';

  const t = (key, ...substitutions) =>
    global.GhPixelDiffI18n?.t(key, ...substitutions) || '';

  /**
   * Во сколько раз растрировать вектор.
   * У SVG собственного размера может не быть вовсе — тогда браузер отдаёт свои
   * 300×150, и сравнение считается по картинке, которой никто не видел.
   * Поэтому длинную сторону доводим до этого размера, но не больше чем ввосьмеро:
   * незачем разворачивать иконку в полотно.
   */
  const RASTER_TARGET = 1024;
  const RASTER_LIMIT = 8;

  /** Картинка с чужого домена — значит нужен CORS. */
  function isForeign(src) {
    try {
      return new URL(src, global.location?.href).origin !== global.location?.origin;
    } catch {
      return true;
    }
  }

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

  /**
   * Загружает картинку так, чтобы холст остался «чистым» и читаемым.
   *
   * crossOrigin ставим только для чужого домена: у GitHub картинки лежат на
   * raw.githubusercontent.com, и без него холст стал бы «грязным». А вот на
   * своём домене — так картинки отдаёт GitLab — он не нужен и вдобавок вреден:
   * запрос уходит без кук, и в закрытом проекте картинка просто не загрузится.
   */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (isForeign(src)) img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      // Вне расширения текста для сообщения нет — тогда в ошибку идёт адрес.
      img.onerror = () => reject(new Error(t('loadFailed', src) || src));
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
   * Холст для чтения пикселей.
   * OffscreenCanvas появился только в Safari 16.4, а расширение ставится с
   * 15.4 — там же, где вообще появились расширения третьей версии. Без запаса
   * на этих версиях сравнение падало бы с ReferenceError.
   */
  function createCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    const canvas = global.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /**
   * Рисует картинку в левом верхнем углу холста заданного размера.
   * Разные размеры — обычное дело: страница стала длиннее, снимок вырос.
   * Масштаб больше единицы бывает только у вектора — растр увеличивать
   * бессмысленно, разницы от этого не прибавится.
   */
  function toImageData(img, width, height, scale = 1) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, img.naturalWidth * scale, img.naturalHeight * scale);
    return ctx.getImageData(0, 0, width, height);
  }

  /** Векторную картинку можно нарисовать в любом размере — растровую нет. */
  function isVector(url) {
    return /\.svg(?:[?#]|$)/i.test(url);
  }

  /**
   * Во сколько раз увеличить вектор, чтобы сравнивать его по существу.
   * Обычно вектор виден по расширению в адресе, но на отдельной странице
   * картинки приходят файлами, и адрес у них `blob:` — там тип известен
   * заранее и приходит флагом.
   */
  function rasterScale(pair, width, height) {
    if (!pair.vector && !isVector(pair.before) && !isVector(pair.after)) return 1;
    const longest = Math.max(width, height) || 1;
    return Math.min(RASTER_LIMIT, Math.max(1, Math.round(RASTER_TARGET / longest)));
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

    const naturalWidth = Math.max(before.naturalWidth, after.naturalWidth);
    const naturalHeight = Math.max(before.naturalHeight, after.naturalHeight);
    // Вырожденный экспорт — картинка нулевого размера. Без этой проверки
    // наружу вылезало «The source width is 0» из внутренностей холста.
    if (!naturalWidth || !naturalHeight) throw new Error(t('emptyImage'));
    const scale = rasterScale(pair, naturalWidth, naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;

    return {
      width,
      height,
      scale,
      before,
      after,
      dataBefore: toImageData(before, width, height, scale),
      dataAfter: toImageData(after, width, height, scale),
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
      scale: prepared.scale ?? 1,
      changed,
      ratio: changed / (width * height),
      bounds: boundsOfChanges(diff.data, width, height),
      diff,
      before: prepared.before,
      after: prepared.after,
      sizeChanged: prepared.sizeChanged,
    };
  }

  // Наружу — только то, чем пользуются панель, поток и тесты.
  global.GhPixelDiff = {
    readImagePair,
    preparePair,
    diffPrepared,
    rewriteRepository,
    boundsOfChanges,
    rasterScale,
  };
})(self);
