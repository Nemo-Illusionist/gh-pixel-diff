// Чистая часть: разбор ссылок на картинки и само сравнение.
// Никакого DOM страницы GitHub — чтобы это можно было проверять тестами.
(function (global) {
  'use strict';

  /**
   * Чем красим разницу. Цвет кодирует направление правки: pixelmatch считает,
   * стало в этом месте темнее или светлее, и просит на это два цвета.
   *
   * Красный — «стало темнее»: так выглядит появившийся текст или элемент на
   * светлом фоне, самый частый случай на снимках интерфейса, и цвет для него
   * остаётся прежним. Синий — «стало светлее»: что-то исчезло или посветлело.
   * Пара красный / синий выбрана ещё и потому, что различима при самом
   * распространённом виде дальтонизма, в отличие от красного с зелёным.
   */
  const DARKER = [209, 36, 47];
  const LIGHTER = [9, 105, 218];

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
   * Сторона клетки, которой нащупываются места изменений, в пикселях кадра.
   *
   * Правка на снимке — это не один пиксель, а пятно: буква, значок, строка.
   * Пиксель к пикселю такие пятна разваливаются на сотни кусочков — между
   * штрихами буквы есть просветы. Клетка в двадцать четыре пикселя сшивает
   * соседние штрихи в одно место и при этом не сливает воедино правки в
   * разных концах кадра.
   */
  const CLUSTER_CELL = 24;
  /**
   * Сколько мест показываем в переходах.
   *
   * Зашумлённое сравнение — пересжатый JPEG, другой шрифт — даёт тысячи
   * крошечных пятен, и переходы по ним бесполезны. Оставляем самые крупные:
   * если правок больше сорока, ходить по ним поштучно всё равно никто не
   * станет.
   */
  const CLUSTER_LIMIT = 40;

  /**
   * Где именно изменилась картинка: общий прямоугольник и отдельные места.
   *
   * Общий прямоугольник для длинного снимка страницы — главное: правка
   * обычно занимает несколько строк, а искать их глазами по трём тысячам
   * пикселей высоты никто не станет. Но когда правок две и они в разных
   * концах кадра, общий прямоугольник — это весь кадр, и обрезка теряет
   * смысл. Поэтому рядом считаются и отдельные места: по ним можно ходить.
   *
   * Читаем готовую маску, а не исходные картинки: в ней закрашены ровно
   * изменившиеся пиксели, а остальное прозрачно. Значит, и границы, и места
   * считаются по тому же порогу, что и число пикселей, — одним проходом.
   *
   * Места ищем по сетке, а не по самим пикселям: сетка на снимке в несколько
   * мегапикселей — это тысячи клеток вместо миллионов точек, и обход её
   * стоит ничего.
   */
  function findChanges(mask, width, height) {
    const cols = Math.max(1, Math.ceil(width / CLUSTER_CELL));
    const rows = Math.max(1, Math.ceil(height / CLUSTER_CELL));
    const count = cols * rows;
    // Границы изменений внутри каждой клетки — в пикселях кадра, а не в
    // клетках: место должно обводиться по самой правке, а не по сетке.
    const cellMinX = new Int32Array(count);
    const cellMinY = new Int32Array(count);
    const cellMaxX = new Int32Array(count).fill(-1);
    const cellMaxY = new Int32Array(count).fill(-1);
    const cellChanged = new Int32Array(count);

    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      const cellRow = Math.floor(y / CLUSTER_CELL) * cols;
      for (let x = 0; x < width; x++) {
        // В маске закрашены только изменившиеся пиксели, остальное прозрачно:
        // непрозрачность и есть признак изменения, каким бы цветом его ни
        // покрасили.
        if (mask[row + x * 4 + 3] === 0) continue;
        const cell = cellRow + Math.floor(x / CLUSTER_CELL);
        // Идём сверху вниз и слева направо, поэтому самый верхний пиксель
        // клетки — первый встреченный, а вот самый левый может найтись и
        // строкой ниже.
        if (cellMaxX[cell] < 0) {
          cellMinX[cell] = x;
          cellMinY[cell] = y;
          cellMaxX[cell] = x;
          cellMaxY[cell] = y;
        } else {
          if (x < cellMinX[cell]) cellMinX[cell] = x;
          if (x > cellMaxX[cell]) cellMaxX[cell] = x;
          if (y > cellMaxY[cell]) cellMaxY[cell] = y;
        }
        cellChanged[cell]++;
      }
    }

    // Клетки, оказавшиеся рядом, — одно место. Соседство считаем по восьми
    // сторонам: правка по диагонали от другой — та же правка.
    const group = new Int32Array(count).fill(-1);
    const stack = new Int32Array(count);
    const clusters = [];
    let bounds = null;

    for (let cell = 0; cell < count; cell++) {
      if (cellMaxX[cell] < 0 || group[cell] >= 0) continue;
      const index = clusters.length;
      let top = 0;
      stack[top++] = cell;
      group[cell] = index;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      let changed = 0;

      while (top > 0) {
        const here = stack[--top];
        if (cellMinX[here] < minX) minX = cellMinX[here];
        if (cellMinY[here] < minY) minY = cellMinY[here];
        if (cellMaxX[here] > maxX) maxX = cellMaxX[here];
        if (cellMaxY[here] > maxY) maxY = cellMaxY[here];
        changed += cellChanged[here];

        const cx = here % cols;
        const cy = (here - cx) / cols;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const next = ny * cols + nx;
            if (cellMaxX[next] < 0 || group[next] >= 0) continue;
            group[next] = index;
            stack[top++] = next;
          }
        }
      }

      const box = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, changed };
      clusters.push(box);
      bounds = bounds
        ? {
            x: Math.min(bounds.x, box.x),
            y: Math.min(bounds.y, box.y),
            width: Math.max(bounds.x + bounds.width, box.x + box.width) - Math.min(bounds.x, box.x),
            height:
              Math.max(bounds.y + bounds.height, box.y + box.height) - Math.min(bounds.y, box.y),
          }
        : { x: box.x, y: box.y, width: box.width, height: box.height };
    }

    // Общий прямоугольник — по всем местам, и только потом отбор: иначе
    // отброшенная мелочь вылезала бы за обрезку «показать всё».
    if (clusters.length > CLUSTER_LIMIT) {
      clusters.sort((a, b) => b.changed - a.changed);
      clusters.length = CLUSTER_LIMIT;
    }
    // Порядок чтения: сверху вниз, слева направо. Так же человек смотрит и
    // сам снимок, и переход «дальше» не прыгает по кадру наугад.
    clusters.sort((a, b) => a.y - b.y || a.x - b.x);

    return { bounds, clusters };
  }

  /** Прямоугольник, в который укладываются все различия. */
  function boundsOfChanges(mask, width, height) {
    return findChanges(mask, width, height).bounds;
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
    const mask = new ImageData(width, height);

    const changed = global.pixelmatch(
      prepared.dataBefore.data,
      prepared.dataAfter.data,
      mask.data,
      width,
      height,
      {
        threshold: options.threshold ?? 0.1,
        includeAA: options.includeAA ?? false,
        // Маска, а не готовый кадр: подложку под неё выбирает тот, кто рисует.
        // Для «разницы» это обесцвеченное «до», для «наложения» — цветное
        // «после». Считать ради двух видов дважды было бы расточительно.
        diffMask: true,
        // Цвет кодирует направление правки: pixelmatch различает, стало в
        // этом месте темнее или светлее. Раньше всё красилось красным, и
        // «текст появился» выглядело так же, как «текст исчез».
        diffColor: LIGHTER,
        diffColorAlt: DARKER,
      },
    );

    const found = findChanges(mask.data, width, height);

    return {
      width,
      height,
      scale: prepared.scale ?? 1,
      changed,
      ratio: changed / (width * height),
      bounds: found.bounds,
      // Места изменений — для переходов между ними: на снимке страницы
      // правки часто в разных концах кадра.
      clusters: found.clusters,
      mask,
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
    findChanges,
    rasterScale,
  };
})(self);
