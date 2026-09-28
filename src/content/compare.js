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
  /**
   * Цвета разницы по умолчанию — и то, как они лежат в настройках.
   *
   * По умолчанию разница одного цвета: красное пятно на кадре читается как
   * «здесь правка», и большего от него обычно не нужно. Направление правки —
   * что потемнело, а что посветлело — цветом показывается по желанию: ответ
   * это ценный, но не всякому и не всегда, а два цвета вместо одного всегда
   * требуют объяснения.
   */
  const COLORS = { direction: false, changed: '#d1242f', lighter: '#0969da' };

  /**
   * Цвет из настроек в тройку чисел, понятную pixelmatch.
   *
   * Значение приходит из хранилища, а туда — из поля ввода браузера, но
   * хранилище переживает и опечатки, и ручную правку. Непонятное значение
   * заменяется своим: сравнение без цвета — это сравнение без разницы.
   */
  function toRgb(value, fallback) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? ''));
    if (!match) return fallback;
    const number = parseInt(match[1], 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  }

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

  /**
   * Путь, по которому GitHub рисует превью картинки в диффе.
   *
   * Хост нарочно не проверяем. На github.com это
   * `viewscreen.githubusercontent.com`, а у своего GitHub Enterprise —
   * `viewscreen.<хост компании>` или сам хост, смотря включена ли изоляция
   * поддоменов. Списка таких адресов не существует, и заранее его не назвать;
   * зато скрипт попадает на страницу только туда, куда человек сам выдал
   * доступ, а дальше решают путь и параметры: две картинки, закодированные
   * так, как это делает один лишь GitHub.
   */
  const VIEWSCREEN_IMG = /^https:\/\/[^/]+\/diff\/img/;

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
   * Сколько строк подряд разрешаем считать вставкой.
   *
   * Предел нужен не ради скорости, а ради смысла: если совпадающих строк
   * почти нет, значит это не «добавили блок», а вообще другая картинка, и
   * выравнивать в ней нечего.
   */
  const ALIGN_MIN_ANCHORS = 4;

  /**
   * Во сколько раз переехавших строк должно быть больше, чем оставшихся без
   * пары, чтобы сшивке поверили.
   *
   * Сшивка умеет объяснить ровно одно: «сверху что-то добавили или убрали, и
   * всё, что ниже, съехало». У такого сдвига переехавших строк всегда кратно
   * больше, чем новых: добавили строку — и за ней поехала вся оставшаяся
   * страница.
   *
   * А вот когда два блока поменялись местами, чисел получается поровну:
   * сколько строк не нашло пары, ровно столько и переехало. Сшивка в этом
   * случае объявляет один блок переехавшим, второй — новым, и половина
   * перестановки пропадает с глаз: вместо двух правок видна одна.
   *
   * Измерено на девяти парах. Настоящие сдвиги дают от 2.4 до 8.1,
   * перестановки — ровно 1.0. Двойка лежит посередине пустого места между
   * ними и ни одну из сторон не задевает.
   */
  const SWAP_RATIO = 2;

  /**
   * Верим ли мы этой сшивке.
   *
   * Не верим — возвращаем выравнивание, которое ничего не двигает: пусть
   * такая пара сравнивается честно, зато обе половины перестановки будут
   * видны.
   */
  function believable(map, inserted, removed) {
    let moved = 0;
    let orphan = 0;
    for (let y = 0; y < map.length; y++) {
      if (map[y] < 0) orphan++;
      else if (map[y] !== y) moved++;
    }
    if (!orphan || moved >= orphan * SWAP_RATIO) return { map, inserted, removed };
    const straight = new Int32Array(map.length);
    for (let y = 0; y < map.length; y++) straight[y] = y;
    return { map: straight, inserted: 0, removed: 0 };
  }

  /**
   * Свёртка строки пикселей в число.
   *
   * FNV-1a, но не по байтам, а по пикселям: тот же буфер читается как
   * Uint32Array, и работы становится вчетверо меньше. На снимке страницы это
   * разница между «незаметно» и «заметно»: свёртка идёт по всем пикселям
   * обеих картинок, а их там миллионы.
   *
   * Хеш, а не сами байты: строки сравниваются только на равенство, а держать
   * ради этого копию картинки — лишние мегабайты. Совпадение хешей у разных
   * строк возможно, но цена ошибки мала: неверно сшитая пара строк тут же
   * разойдётся попиксельным сравнением.
   */
  function rowHashes(data, width, height, from = 0, to = width) {
    const pixels = new Uint32Array(data.buffer, data.byteOffset, width * height);
    const hashes = new Uint32Array(height);
    for (let y = 0; y < height; y++) {
      let hash = 0x811c9dc5;
      const start = y * width;
      for (let i = start + from; i < start + to; i++) {
        hash = Math.imul(hash ^ pixels[i], 0x01000193);
      }
      hashes[y] = hash >>> 0;
    }
    return hashes;
  }

  /** Самая длинная возрастающая подпоследовательность — по значениям. */
  function longestIncreasing(values) {
    const tails = [];
    const back = new Int32Array(values.length).fill(-1);
    const ends = [];
    for (let i = 0; i < values.length; i++) {
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (values[ends[middle]] < values[i]) low = middle + 1;
        else high = middle;
      }
      if (low > 0) back[i] = ends[low - 1];
      ends[low] = i;
      if (low === tails.length) tails.push(i);
      else tails[low] = i;
    }
    const chain = [];
    for (let i = ends[tails.length - 1] ?? -1; i >= 0; i = back[i]) chain.push(i);
    return chain.reverse();
  }

  /**
   * Сколько раз строка может повториться, чтобы участвовать в голосовании.
   *
   * Однотонный фон занимает сотни одинаковых строк: пар из них получаются
   * десятки тысяч, и голосуют они за все сдвиги сразу. Предел здесь не о
   * смысле, а о работе — голос такой строки всё равно почти ничего не весит.
   */
  const SHIFT_REPEATS = 64;

  /** Насколько согласие строк при сдвиге должно превзойти согласие без него. */
  const SHIFT_GAIN = 1.25;
  /** И насколько согласие вообще должно быть, чтобы считаться согласием. */
  const SHIFT_MIN_ROWS = 8;

  /**
   * Сколько содержательных строк совпало, если «до» сдвинуть на offset.
   *
   * Однотонные строки в счёт не идут: фон совпадает с фоном при любом сдвиге
   * и на вопрос «правильный ли это сдвиг» не отвечает вовсе.
   */
  function agreement(before, after, offset, worth) {
    let same = 0;
    for (let y = 0; y < after.length; y++) {
      if (!worth[y]) continue;
      const source = y + offset;
      if (source >= 0 && source < before.length && before[source] === after[y]) same++;
    }
    return same;
  }

  /**
   * Общий сдвиг кадра, если якорей не нашлось.
   *
   * Уникальных строк может не быть вовсе: снимок из одноцветных полос, схема,
   * график. Тогда строки голосуют за сдвиг — каждая за тот, при котором она
   * встала бы на своё место, — и побеждает тот, при котором содержательных
   * строк сходится заметно больше, чем без всякого сдвига. Именно «заметно»:
   * иначе панель начнёт двигать кадр от любого совпадения фона с фоном.
   */
  function bestShift(before, after, height) {
    const places = new Map();
    for (let y = 0; y < height; y++) {
      const at = places.get(before[y]);
      if (at === undefined) places.set(before[y], [y]);
      else if (at.length < SHIFT_REPEATS) at.push(y);
    }
    const repeats = new Map();
    for (let y = 0; y < height; y++) repeats.set(after[y], (repeats.get(after[y]) ?? 0) + 1);
    // Содержательные строки: те, что не повторяются в кадре без конца.
    const worth = new Uint8Array(height);
    for (let y = 0; y < height; y++) {
      worth[y] = (repeats.get(after[y]) ?? 1) < SHIFT_REPEATS ? 1 : 0;
    }

    const votes = new Map();
    for (let y = 0; y < height; y++) {
      const at = places.get(after[y]);
      if (!at || !worth[y] || at.length >= SHIFT_REPEATS) continue;
      // Голос делится на число двойников: строка, повторяющаяся в кадре
      // сорок раз, знает о сдвиге в сорок раз меньше, чем единственная в
      // своём роде. Без этого полоса фона перекрикивает любой текст.
      const weight = 1 / (at.length * (repeats.get(after[y]) ?? 1));
      for (const source of at) {
        const offset = source - y;
        if (offset === 0) continue;
        votes.set(offset, (votes.get(offset) ?? 0) + weight);
      }
    }
    if (!votes.size) return 0;

    // Проверяем не по числу голосов, а по делу: сколько строк сойдётся.
    const base = agreement(before, after, 0, worth);
    let best = 0;
    let bestSame = Math.max(base * SHIFT_GAIN, SHIFT_MIN_ROWS);
    const candidates = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [offset] of candidates) {
      const same = agreement(before, after, offset, worth);
      if (same > bestSame) {
        bestSame = same;
        best = offset;
      }
    }
    return best;
  }

  /**
   * Сшивает строки «до» со строками «после».
   *
   * Зачем. Добавленный наверху элемент сдвигает всё, что ниже, и попиксельное
   * сравнение честно объявляет изменившимся весь кадр. Ответ «поменялось всё»
   * верен и бесполезен: на деле поменялась одна строка, а остальные переехали.
   *
   * Как. Тем же приёмом, которым текстовые диффы отличают «строку поправили»
   * от «строку вставили»: строки, встретившиеся ровно по разу в обеих
   * картинках и совпавшие, — надёжные якоря. Из них берётся самая длинная
   * возрастающая цепочка (порядок строк переставляться не может), а промежутки
   * между якорями паруются один к одному сверху вниз; что не поместилось —
   * вставка или удаление.
   *
   * Якорями служат уникальные строки, потому что повторяющиеся — например,
   * пустой фон — сшили бы кадр как попало.
   *
   * @returns {{map: Int32Array, inserted: number, removed: number}} map — для
   *          каждой строки «после» номер её строки в «до» или -1, если такой
   *          строки там не было
   */
  function alignRows(dataBefore, dataAfter, width, height, from = 0, to = width) {
    const before = rowHashes(dataBefore, width, height, from, to);
    const after = rowHashes(dataAfter, width, height, from, to);

    // Где какая строка встречается. -1 — не встречалась, -2 — не один раз.
    const seen = new Map();
    for (let y = 0; y < height; y++) {
      const hash = before[y];
      seen.set(hash, seen.has(hash) ? -2 : y);
    }
    const anchorsBefore = [];
    const anchorsAfter = [];
    const taken = new Map();
    for (let y = 0; y < height; y++) {
      const hash = after[y];
      const at = seen.get(hash);
      if (at === undefined || at < 0) continue;
      // Уникальной строка должна быть в обеих картинках: иначе якорь
      // ненадёжен.
      if (taken.has(hash)) {
        taken.set(hash, -2);
        continue;
      }
      taken.set(hash, y);
    }
    for (const [hash, y] of taken) {
      if (y < 0) continue;
      anchorsAfter.push(y);
      anchorsBefore.push(seen.get(hash));
    }
    // По возрастанию строки «после» — порядок для поиска цепочки.
    const order = anchorsAfter
      .map((y, index) => index)
      .sort((a, b) => anchorsAfter[a] - anchorsAfter[b]);
    const chain = longestIncreasing(order.map((index) => anchorsBefore[index]));

    const map = new Int32Array(height).fill(-1);
    if (chain.length < ALIGN_MIN_ANCHORS) {
      // Якорей не нашлось: уникальных строк в картинке может не быть вовсе.
      // Тогда остаётся общий сдвиг — или не остаётся ничего, и строки стоят
      // на своих местах, как было до всякого выравнивания.
      const offset = bestShift(before, after, height);
      let shiftedIn = 0;
      for (let y = 0; y < height; y++) {
        const source = y + offset;
        if (source >= 0 && source < height) map[y] = source;
        else shiftedIn++;
      }
      return believable(map, offset ? shiftedIn : 0, offset ? shiftedIn : 0);
    }

    /** Паруем промежуток между якорями один к одному, сверху вниз. */
    let inserted = 0;
    let removed = 0;
    const fill = (fromAfter, toAfter, fromBefore, toBefore) => {
      const rows = Math.min(toAfter - fromAfter, toBefore - fromBefore);
      for (let i = 0; i < rows; i++) map[fromAfter + i] = fromBefore + i;
      inserted += toAfter - fromAfter - rows;
      removed += toBefore - fromBefore - rows;
    };

    let prevAfter = 0;
    let prevBefore = 0;
    for (const link of chain) {
      const index = order[link];
      const y = anchorsAfter[index];
      const source = anchorsBefore[index];
      fill(prevAfter, y, prevBefore, source);
      map[y] = source;
      prevAfter = y + 1;
      prevBefore = source + 1;
    }
    fill(prevAfter, height, prevBefore, height);

    return believable(map, inserted, removed);
  }

  /**
   * Пересобирает «до» в координатах «после».
   *
   * Строка, которой в «до» не нашлось пары, сравнивается с тем, что было на
   * этом месте раньше, — то есть как без всякого сшивания. Так вставка
   * показывает ровно то, что на ней видно нового: поставь напротив неё
   * пустоту, и вся полоса, включая пустые поля, объявилась бы изменившейся,
   * а число изменившихся пикселей выросло бы там, где глазами ничего не
   * прибавилось.
   */
  function shiftRows(data, map, width) {
    const bytes = width * 4;
    const shifted = new Uint8ClampedArray(map.length * bytes);
    for (let y = 0; y < map.length; y++) {
      const source = map[y] < 0 ? y : map[y];
      if (source >= map.length) continue;
      shifted.set(data.subarray(source * bytes, source * bytes + bytes), y * bytes);
    }
    return shifted;
  }

  /**
   * Второй способ выровнять: найти, где кадры разошлись, и сдвинуть остаток
   * целиком.
   *
   * Якоря хороши, пока уникальных строк много, но платят за это дробностью:
   * один неверно узнанный якорь ломает сдвиг на единицу, и ниже него каждая
   * рамка, каждая линейка светится краснотой в пиксель толщиной. На снимке
   * интерфейса таких линий десятки, и вместе они дают больше красноты, чем
   * сама правка.
   *
   * Здесь наоборот: сверху ищется последняя строка, совпавшая до единого
   * пикселя, а всё, что ниже, объявляется съехавшим на один и тот же сдвиг —
   * тот, за который проголосуют сами строки. Дробиться нечему.
   *
   * Способ проще и потому грубее: он умеет объяснить одну вставку или одно
   * удаление, а не россыпь правок. Поэтому он не заменяет якоря, а спорит с
   * ними — и побеждает тот, после которого краснота меньше.
   */
  function alignPrefix(dataBefore, dataAfter, width, height, from = 0, to = width) {
    const before = rowHashes(dataBefore, width, height, from, to);
    const after = rowHashes(dataAfter, width, height, from, to);

    let top = 0;
    while (top < height && before[top] === after[top]) top++;
    // Кадры совпали целиком или разошлись у самого низа: двигать нечего.
    if (height - top < SHIFT_MIN_ROWS) return null;

    const offset = bestShift(before.subarray(top), after.subarray(top), height - top);
    if (!offset) return null;

    const map = new Int32Array(height);
    let orphan = 0;
    for (let y = 0; y < height; y++) {
      if (y < top) {
        map[y] = y;
        continue;
      }
      const source = y + offset;
      if (source >= top && source < height) map[y] = source;
      else {
        map[y] = -1;
        orphan++;
      }
    }
    return believable(map, orphan, orphan);
  }

  /**
   * Ширина полосы, которой кадр делится вдоль, в пикселях.
   *
   * Отпечаток строки берётся во всю ширину кадра, и это его главная беда: на
   * странице с двумя колонками правка слева убивает строку целиком, а сдвиг
   * тащит за собой правую колонку, которая никуда не ехала, — та краснеет
   * ни за что. Поэтому кадр делится вдоль, и каждая полоса ищет свой сдвиг
   * сама.
   *
   * Четыреста — это примерно колонка интерфейса. Уже — и в полосе не
   * останется уникальных строк, по которым она узнаёт себя; шире — и соседние
   * колонки снова склеиваются в одну судьбу.
   */
  const BAND_WIDTH = 400;
  /** Меньше двух полос делить незачем: это и есть прежнее поведение. */
  const BANDS_MAX = 4;

  /**
   * Собирает «до» в координатах «после», давая каждой полосе свой сдвиг.
   *
   * Берём от каждой полосы её столбцы из той строки, которую нашла она сама.
   * Полоса, не нашедшая ничего, остаётся на месте — как было до всякого
   * выравнивания.
   */
  /**
   * Во что обходится пути смена положения, в пикселях.
   *
   * Плата нужна, чтобы строки не дёргались поодиночке от случайного
   * совпадения: сдвинуться должен целый кусок кадра сразу. Восемь пикселей —
   * меньше любой настоящей правки и больше любой ряби на краю рисунка,
   * поэтому граница между сдвигами уезжает туда, где переход ничего не
   * стоит, — в однотонный промежуток между карточками.
   */
  const SNAP_SWITCH = 8;

  /**
   * Сколько пикселей в строке не совпало.
   *
   * Сравнение точное, без порога: доводка ищет строку, вставшую ровно на своё
   * место, а не похожую.
   */
  function rowDiff(before, after, source, y, width, from, to) {
    let apart = 0;
    const b = source * width;
    const a = y * width;
    for (let x = from; x < to; x++) if (before[b + x] !== after[a + x]) apart++;
    return apart;
  }

  /**
   * Доводка выравнивания на один пиксель.
   *
   * Зачем. Вёрстка двигает строки не поровну: вставленная плашка опускает
   * одну карточку на сорок три пикселя, соседнюю — на сорок два, потому что
   * округления отступов легли по-разному. Сшивка целыми строками такой
   * разнобой передать умеет, а вот угадать, где именно сдвиг меняется,
   * — нет: между якорями лежит однотонный фон, и граница ставится наугад.
   * Промах в пиксель ничего не значит на глаз, но каждая линейка, каждая
   * рамка карточки под ним светится краснотой во всю ширину.
   *
   * Как. Каждой строке предлагается три положения — своё и на пиксель в обе
   * стороны, — и выбирается не лучшее для каждой по отдельности, а самый
   * дешёвый путь по кадру сверху вниз, со своей платой за каждую смену
   * положения. Дальше пиксела доводка не ходит: всё, что больше, — работа
   * самого выравнивания, и способов у него два.
   */
  function snapRows(dataBefore, dataAfter, width, height, map, from = 0, to = width) {
    const before = new Uint32Array(dataBefore.buffer, dataBefore.byteOffset);
    const after = new Uint32Array(dataAfter.buffer, dataAfter.byteOffset);
    const steps = [-1, 0, 1];
    const count = steps.length;

    // Каждой строке предлагается три положения — своё и на пиксель в обе
    // стороны, — но выбираются они не поодиночке, а все разом: ищется самый
    // дешёвый путь сверху вниз. Поодиночке нельзя: соседние строки прижались
    // бы к одному источнику, и он нарисовался бы дважды, а его сосед пропал.
    // Шов от этого виден там же, где был промах, — чертой по краю кружка.
    //
    // Путь платит за каждую смену положения. Поэтому граница между сдвигами
    // сама уезжает в однотонный промежуток между карточками: там переход
    // ничего не стоит, а на краю рисунка обошёлся бы дорого.
    const cost = new Float64Array(height * count);
    const came = new Uint8Array(height * count);
    const alive = new Uint8Array(height);

    for (let y = 0; y < height; y++) {
      const source = map[y];
      // Строка без пары остаётся на месте и пути не ведёт: ниже неё выбор
      // начинается заново.
      if (source < 0 || source >= height) continue;
      alive[y] = 1;
      const head = !y || !alive[y - 1];
      for (let k = 0; k < count; k++) {
        const near = source + steps[k];
        const own =
          near >= 0 && near < height ? rowDiff(before, after, near, y, width, from, to) : Infinity;
        let best = 0;
        let step = k;
        if (!head) {
          best = Infinity;
          for (let j = 0; j < count; j++) {
            const path = cost[(y - 1) * count + j] + (j === k ? 0 : SNAP_SWITCH);
            if (path < best) {
              best = path;
              step = j;
            }
          }
        }
        cost[y * count + k] = own + best;
        came[y * count + k] = step;
      }
    }

    // Обратный проход: каждый участок разматывается от своей последней строки.
    const snapped = Int32Array.from(map);
    let moved = 0;
    for (let tail = height - 1; tail >= 0; tail--) {
      if (!alive[tail] || (tail + 1 < height && alive[tail + 1])) continue;
      let at = 0;
      for (let k = 1; k < count; k++) if (cost[tail * count + k] < cost[tail * count + at]) at = k;
      for (let y = tail; y >= 0 && alive[y]; y--) {
        const near = map[y] + steps[at];
        if (near !== map[y] && near >= 0 && near < height) {
          snapped[y] = near;
          moved++;
        }
        at = came[y * count + at];
      }
    }
    return moved ? snapped : null;
  }

  /**
   * Та же доводка, но для целой догадки — хоть по всему кадру, хоть по полосам.
   */
  function snapAligned(prepared, aligned) {
    const { width, height } = prepared;
    const dataBefore = prepared.dataBefore.data;
    const dataAfter = prepared.dataAfter.data;
    if (!aligned.bands) {
      const map = snapRows(dataBefore, dataAfter, width, height, aligned.map);
      return map ? { ...aligned, map } : null;
    }
    let moved = false;
    const bands = aligned.bands.map((band) => {
      const map = snapRows(dataBefore, dataAfter, width, height, band.map, band.from, band.to);
      if (!map) return band;
      moved = true;
      return { ...band, map };
    });
    return moved ? { ...aligned, bands } : null;
  }

  function shiftBands(data, bands, width, height) {
    const bytes = width * 4;
    const shifted = new Uint8ClampedArray(height * bytes);
    for (let y = 0; y < height; y++) {
      for (const { map, from, to } of bands) {
        const source = map[y] < 0 ? y : map[y];
        if (source >= height) continue;
        shifted.set(
          data.subarray(source * bytes + from * 4, source * bytes + to * 4),
          y * bytes + from * 4,
        );
      }
    }
    return shifted;
  }

  /**
   * Выравнивает кадр по полосам: каждая ищет свой сдвиг по своим столбцам.
   *
   * @returns {{bands: Array, inserted: number, removed: number}|null}
   *          null — делить нечего или ни одна полоса ничего не нашла
   */
  function alignBands(dataBefore, dataAfter, width, height, align = alignRows) {
    const count = Math.min(BANDS_MAX, Math.floor(width / BAND_WIDTH));
    if (count < 2) return null;

    const bands = [];
    let inserted = 0;
    let removed = 0;
    let moved = false;
    for (let i = 0; i < count; i++) {
      const from = Math.round((width * i) / count);
      const to = i === count - 1 ? width : Math.round((width * (i + 1)) / count);
      const aligned = align(dataBefore, dataAfter, width, height, from, to);
      if (!aligned) continue;
      bands.push({ ...aligned, from, to });
      // Строки считаем по самой деятельной полосе, а не суммой: подпись
      // говорит, на сколько строк уехало содержимое, и складывать это число
      // по колонкам значило бы утроить его на ровном месте.
      inserted = Math.max(inserted, aligned.inserted);
      removed = Math.max(removed, aligned.removed);
      if (aligned.inserted || aligned.removed) moved = true;
    }
    return moved ? { bands, inserted, removed } : null;
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
        // В маске закрашены только изменившиеся пиксели, остальное прозрачно.
        // Признак изменения — полная непрозрачность, каким бы цветом его ни
        // покрасили: вполсилы нарисованы отметки сглаживания, а они не
        // изменения и границы собой раздвигать не должны.
        if (mask[row + x * 4 + 3] !== 255) continue;
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
      // Общая часть: там, где обе версии есть на самом деле. Холст берётся по
      // большей из картинок, и у меньшей край остаётся пустым — сравнивать
      // его не с чем.
      common: {
        width: Math.min(before.naturalWidth, after.naturalWidth) * scale,
        height: Math.min(before.naturalHeight, after.naturalHeight) * scale,
      },
      sizeChanged:
        before.naturalWidth !== after.naturalWidth ||
        before.naturalHeight !== after.naturalHeight,
    };
  }

  /**
   * Одно сравнение: с заданной сшивкой строк или без неё вовсе.
   *
   * Вынесено отдельно ровно затем, чтобы обе попытки — сшитую и честную —
   * можно было провести одинаково и сравнить их между собой.
   */
  function compareOnce(prepared, options, aligned) {
    const { width, height } = prepared;
    const mask = new ImageData(width, height);

    let shifted = prepared.dataBefore.data;
    if (aligned && (aligned.inserted || aligned.removed)) {
      shifted = aligned.bands
        ? shiftBands(prepared.dataBefore.data, aligned.bands, width, height)
        : shiftRows(prepared.dataBefore.data, aligned.map, width);
    }

    const changed = global.pixelmatch(
      shifted,
      prepared.dataAfter.data,
      mask.data,
      width,
      height,
      {
        threshold: options.threshold ?? 0.1,
        includeAA: options.includeAA ?? false,
        // Отметки сглаживания — тоже ответ: «здесь сдвинулось на полпикселя».
        // Изменением они не считаются и в подсчёт не идут, но пропадать с
        // кадра им незачем — в маске они рисуются вполсилы.
        aaMask: true,
        // Маска, а не готовый кадр: подложку под неё выбирает тот, кто рисует.
        // Для «разницы» это обесцвеченное «до», для «наложения» — цветное
        // «после». Считать ради двух видов дважды было бы расточительно.
        diffMask: true,
        // Цвет кодирует направление правки: pixelmatch различает, стало в
        // этом месте темнее или светлее. Раньше всё красилось красным, и
        // «текст появился» выглядело так же, как «текст исчез».
        // Цвета можно поменять в настройках: красное на красном интерфейсе
        // теряется, а пара красный / синий различима не при всяком
        // дальтонизме. Без «направления» оба цвета — один и тот же: маска
        // красится ровно так же, как красилась всегда.
        diffColor: options.colors?.direction
          ? toRgb(options.colors?.lighter, LIGHTER)
          : toRgb(options.colors?.changed, DARKER),
        diffColorAlt: toRgb(options.colors?.changed, DARKER),
      },
    );

    // Край, которого у одной из версий нет, изменением не считается.
    //
    // Кадр стал на два десятка строк короче — и эти строки, сравненные с
    // пустотой, дают сплошную красную полосу и десятки тысяч «изменившихся»
    // пикселей. На снимке страницы это девять десятых всей находки: настоящая
    // правка тонет в полосе, которая и так названа словами в подписи.
    // Поэтому край отмечается вполсилы, как сглаживание: виден, но ни в счёт,
    // ни в границы, ни в места изменений не идёт.
    //
    // Тоже под бетой, и вместе со сшиванием: обе поправки меняют само число в
    // подписи, а число — то, на что смотрят в первую очередь. Пусть сначала
    // поживут у тех, кто их включил нарочно.
    const common = options.beta ? (prepared.common ?? { width, height }) : { width, height };
    let outside = 0;
    if (common.width < width || common.height < height) {
      for (let y = 0; y < height; y++) {
        const edge = y >= common.height;
        for (let x = edge ? 0 : common.width; x < width; x++) {
          const i = (y * width + x) * 4;
          if (mask.data[i + 3] !== 255) continue;
          mask.data[i + 3] = 128;
          outside++;
        }
      }
    }

    const found = findChanges(mask.data, width, height);

    return {
      width,
      height,
      scale: prepared.scale ?? 1,
      changed: changed - outside,
      // Доля считается от общей части: делить на кадр, которого у одной из
      // версий нет, значит занижать долю тем сильнее, чем больше он вырос.
      ratio: (changed - outside) / (common.width * common.height || width * height),
      // Сколько строк прибавилось и убавилось: сдвиг стоит не только показать,
      // но и назвать — «весь кадр красный» и «вставлено 24 строки» это разные
      // ответы, даже когда картинка одна и та же.
      inserted: aligned?.inserted ?? 0,
      removed: aligned?.removed ?? 0,
      rows: aligned && (aligned.inserted || aligned.removed) ? (aligned.map ?? null) : null,
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

  /**
   * Сравнивает уже загруженную пару с заданным порогом.
   *
   * Сшивание строк — по просьбе, а не по умолчанию.
   *
   * Там, где элемент добавили наверху, оно спасает кадр от сплошной красноты.
   * Но это догадка, и садится она мимо чаще, чем хотелось бы: на однообразном
   * содержимом строки неразличимы и сшиваются как попало, а перестановку двух
   * блоков местами сшивка отработать не может вовсе — порядок строк ей
   * менять нельзя, и из двух переехавших блоков она берёт один.
   *
   * Поэтому догадку проверяем: считаем оба раза и оставляем тот ответ, где
   * изменений меньше. Сшивка, которая ничего не улучшила, отбрасывается
   * вместе со своей подписью — значит и «строк +137 −137» под кадром не
   * появится там, где эти строки никому не помогли.
   *
   * Второй проход стоит ровно одного сравнения и делается только тогда,
   * когда сшивка вообще что-то нашла.
   *
   * @returns {{width, height, changed, ratio, bounds, mask: ImageData,
   *            before: HTMLImageElement, after: HTMLImageElement,
   *            sizeChanged: boolean}}
   */
  function diffPrepared(prepared, options = {}) {
    const { width, height } = prepared;
    const asIs = compareOnce(prepared, options, null);
    if (!options.beta) return asIs;

    // Догадки о том, что куда переехало, и каждая проверяется делом.
    //
    // Два способа выровнять — по якорям и по общему сдвигу ниже расхождения —
    // и два взгляда на кадр: целиком и по продольным полосам. Полосы нужны
    // затем, что колонка умеет переехать в одиночку, а соседняя при этом
    // остаётся на месте и краснеть ни за что не должна.
    //
    // Каждая догадка стоит одного сравнения, и худшее, что она может
    // сделать, — проиграть.
    const { data: dataBefore } = prepared.dataBefore;
    const { data: dataAfter } = prepared.dataAfter;
    let best = asIs;
    const guesses = [
      alignRows(dataBefore, dataAfter, width, height),
      alignBands(dataBefore, dataAfter, width, height),
      alignPrefix(dataBefore, dataAfter, width, height),
      alignBands(dataBefore, dataAfter, width, height, alignPrefix),
    ];
    for (const aligned of guesses) {
      if (!aligned || !(aligned.inserted || aligned.removed)) continue;
      const stitched = compareOnce(prepared, options, aligned);
      if (stitched.changed < best.changed) best = stitched;
      // Доводка идёт каждой догадке, а не одной победившей: выигрывает не
      // обязательно та, что была впереди до неё. Догадка, проигравшая пару
      // тысяч пикселей, после доводки обходила победительницу — и мы этого
      // не видели, потому что не считали.
      const snapped = snapAligned(prepared, aligned);
      if (!snapped) continue;
      const refined = compareOnce(prepared, options, snapped);
      if (refined.changed < best.changed) best = refined;
    }
    return best;
  }

  // Наружу — только то, чем пользуются панель, поток и тесты.
  global.GhPixelDiff = {
    readImagePair,
    preparePair,
    diffPrepared,
    rewriteRepository,
    boundsOfChanges,
    toRgb,
    COLORS,
    findChanges,
    alignRows,
    alignPrefix,
    snapRows,
    rasterScale,
  };
})(self);
