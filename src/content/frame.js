// Встраивание в панель просмотра картинок GitHub.
//
// Превью бинарных файлов GitHub рисует в отдельном фрейме на своём домене:
// там лежат обе версии картинки и переключатель «2-up / Swipe / Onion Skin».
// Расширение добавляет к ним четвёртый режим — и работает по тем же правилам,
// что и родные: своя радиокнопка, свой контейнер `.view`, свой ползунок.
(function (global) {
  'use strict';

  const { diffPrepared, preparePair, readImagePair } = global.GhPixelDiff;
  const api = global.browser ?? global.chrome;
  const { plural, t } = global.GhPixelDiffI18n;

  const MODE = 'pixel-diff';
  const CROP_PADDING = 40;
  /** Порог pixelmatch: 0 — ловит даже сглаживание, 0.5 — только явные отличия. */
  const THRESHOLD_MAX = 0.5;
  const THRESHOLD_DEFAULT = 0.1;
  const THRESHOLD_KEY = 'ghpd:threshold';
  const OUTLINE_KEY = 'ghpd:outline';
  const MODE_KEY = 'ghpd:mode';
  /** Настройка из окна расширения: показывать ли переключатель кадров. */
  const SHOW_VIEWS_DEFAULT = true;

  /** Репозиторий страницы: GitHub кладёт его во фрейм параметром `nwo`. */
  function repositoryFromUrl() {
    const nwo = new URL(location.href).searchParams.get('nwo');
    if (!nwo) return null;
    const [owner, name] = nwo.split('/');
    return owner && name ? { owner, name } : null;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.append(text);
    return node;
  }

  /**
   * Порог живёт между картинками: подобрав его на одном снимке, читать diff
   * дальше хочется с тем же. Хранилище фрейма для этого и годится — оно своё
   * у домена viewscreen и переживает переход к следующему файлу.
   */
  function readSetting(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      // Приватный режим и запрет на хранилище — не повод падать.
      return null;
    }
  }

  function saveSetting(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // См. выше.
    }
  }

  function readThreshold() {
    // Именно так: Number(null) — это ноль, и без проверки на пустоту порог
    // молча уезжал бы в самый левый край при первом же открытии.
    const stored = readSetting(THRESHOLD_KEY);
    const saved = Number(stored);
    if (stored !== null && Number.isFinite(saved) && saved >= 0 && saved <= THRESHOLD_MAX) {
      return saved;
    }
    return THRESHOLD_DEFAULT;
  }

  /**
   * Ползунок порога — в том же виде, что у режима Onion Skin: тонкая дорожка
   * между двумя метками. Классы GitHub здесь не годятся: их стили живут внутри
   * onion-skin-контейнера и снаружи прячут элемент, поэтому вид повторён своим.
   *
   * Внутри — родной input[type=range]: он один даёт и клавиатуру, и стрелки,
   * и озвучку скринридером, которых у собранного из div'ов ползунка нет.
   */
  function createSlider(onChange) {
    const controls = el('div', 'ghpd-controls');
    const input = el('input', 'ghpd-slider');
    input.type = 'range';
    input.min = '0';
    input.max = String(THRESHOLD_MAX);
    input.step = '0.01';
    input.value = String(readThreshold());
    input.setAttribute('aria-label', t('thresholdLabel'));
    input.title = t('thresholdHint');

    input.addEventListener('input', () => {
      const value = Number(input.value);
      saveSetting(THRESHOLD_KEY, value);
      onChange(value);
    });

    controls.append(
      el('span', 'ghpd-mark ghpd-mark-small'),
      input,
      el('span', 'ghpd-mark ghpd-mark-large'),
    );

    return { element: controls, get value() { return Number(input.value); } };
  }

  /**
   * Задаёт холсту соотношение сторон явно.
   * Без этого размер коробки остаётся на усмотрение браузера: Safari внутри
   * flex-контейнера растягивает её по одной стороне, картинка вписывается по
   * другой, и рядом с кадром внутри рамки появляется пустая полоса.
   */
  function fitCanvas(canvas) {
    canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  }

  /**
   * Заводит поток для сравнения.
   *
   * Собираем его из тех же файлов, что и content script: расширение не может
   * создать Worker прямо со своего адреса — страница другого происхождения, —
   * поэтому исходники читаются через fetch и склеиваются в blob. Если это не
   * вышло (нет chrome.runtime, запрещён blob), считаем в общем потоке: медленнее,
   * но работает.
   */
  async function createWorker() {
    if (!api?.runtime?.getURL || typeof Worker !== 'function') return null;
    try {
      const sources = await Promise.all(
        ['vendor/pixelmatch.js', 'content/compare.js', 'content/worker.js'].map((path) =>
          fetch(api.runtime.getURL(path)).then((response) => response.text()),
        ),
      );
      const url = URL.createObjectURL(new Blob(sources, { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      return worker;
    } catch {
      return null;
    }
  }

  /**
   * Показывать ли переключатель «до / после / разница».
   * Живёт в хранилище расширения, а не фрейма: ставится в окне расширения,
   * читается здесь. Нет хранилища — показываем.
   */
  async function readShowViews() {
    try {
      const stored = await api?.storage?.sync?.get({ showViews: SHOW_VIEWS_DEFAULT });
      return stored?.showViews ?? SHOW_VIEWS_DEFAULT;
    } catch {
      return SHOW_VIEWS_DEFAULT;
    }
  }

  function drawCrop(canvas, full, result, cropped, outline, view) {
    // Холст с полным кадром один на всю панель: на снимке в несколько
    // мегапикселей заводить его заново на каждую отрисовку — лишние десятки
    // мегабайт при каждом движении ползунка.
    full.width = result.width;
    full.height = result.height;
    const source = full.getContext('2d');
    if (view === 'diff') {
      source.putImageData(result.diff, 0, 0);
    } else {
      // «До» и «после» рисуем в том же размере, что и разницу: у вектора это
      // увеличенный кадр, и переключение не должно менять масштаб.
      const image = result[view];
      source.clearRect(0, 0, result.width, result.height);
      source.drawImage(
        image,
        0,
        0,
        image.naturalWidth * result.scale,
        image.naturalHeight * result.scale,
      );
    }

    if (!cropped || !result.bounds) {
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(full, 0, 0);
      // Кадр показывается уменьшенным, и несколько изменившихся пикселей на нём
      // просто исчезают. Поэтому обводим место, где они нашлись — если рамка
      // не мешает: на мелком снимке она закрывает половину кадра.
      if (result.bounds && outline) {
        const box = result.bounds;
        const margin = Math.max(6, Math.round(Math.max(result.width, result.height) / 120));
        ctx.strokeStyle = '#d1242f';
        ctx.lineWidth = Math.max(2, Math.round(Math.max(result.width, result.height) / 400));
        ctx.strokeRect(
          box.x - margin,
          box.y - margin,
          box.width + margin * 2,
          box.height + margin * 2,
        );
      }
      return { x: 0, y: 0, width: result.width, height: result.height };
    }

    const box = result.bounds;
    const x = Math.max(0, box.x - CROP_PADDING);
    const y = Math.max(0, box.y - CROP_PADDING);
    const width = Math.min(result.width - x, box.width + CROP_PADDING * 2);
    const height = Math.min(result.height - y, box.height + CROP_PADDING * 2);
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(full, x, y, width, height, 0, 0, width, height);
    return { x, y, width, height };
  }

  function build(pair, modes) {
    // Родной класс `view` не берём: его CSS прячет всё, кроме активного
    // режима, а видимостью своего контейнера мы управляем сами.
    const view = el('div', 'ghpd-view');
    view.hidden = true;

    const shell = el('span', 'shell ghpd-shell');
    const canvas = el('canvas', 'ghpd-canvas');
    const full = document.createElement('canvas');

    const meta = el('p', 'ghpd-meta');
    const cropToggle = el('button', 'ghpd-crop-toggle');
    cropToggle.type = 'button';
    const outlineToggle = el('button', 'ghpd-outline-toggle');
    outlineToggle.type = 'button';

    shell.append(canvas, meta);
    view.append(shell);

    let result = null;
    let prepared = null;
    let loading = null;
    let worker = null;
    let request = 0;
    let cropped = true;
    // Какой из трёх кадров показан: разница, «до» или «после».
    let shownFrame = 'diff';
    // Рамка вокруг изменений — по умолчанию да: без неё правку в несколько
    // пикселей на уменьшенном кадре не найти. Но на мелком снимке она сама
    // закрывает картинку, поэтому её можно убрать, и выбор запоминается.
    let outline = readSetting(OUTLINE_KEY) !== 'off';

    const render = () => {
      const box = drawCrop(canvas, full, result, cropped, outline, shownFrame);
      fitCanvas(canvas);
      const percent = result.ratio * 100;
      const shown = percent >= 0.01 ? percent.toFixed(2) : '<0.01';

      meta.replaceChildren();
      meta.append(
        el('strong', null, plural('pixels', result.changed)),
        ` · ${t('shareOfFrame', shown)}`,
      );
      if (result.bounds) {
        cropToggle.textContent = cropped
          ? t('showFullFrame', box.width, box.height)
          : t('showChangesOnly');
        meta.append(' · ', cropToggle);
        // Рамка есть только в полном кадре — там же и переключатель.
        if (!cropped) {
          outlineToggle.textContent = outline ? t('hideOutline') : t('showOutline');
          meta.append(' · ', outlineToggle);
        }
      }
      // У вектора собственного размера может не быть: сказать, в чём считали,
      // честнее, чем показывать проценты от неизвестно чего.
      if (result.scale > 1) {
        meta.append(` · ${t('rasterized', result.width, result.height)}`);
      }
      if (result.sizeChanged) {
        meta.append(
          ` · ${t(
            'sizeChanged',
            `${result.before.naturalWidth}×${result.before.naturalHeight}`,
            `${result.after.naturalWidth}×${result.after.naturalHeight}`,
          )}`,
        );
      }
    };

    cropToggle.addEventListener('click', () => {
      cropped = !cropped;
      render();
    });

    outlineToggle.addEventListener('click', () => {
      outline = !outline;
      saveSetting(OUTLINE_KEY, outline ? 'on' : 'off');
      render();
    });

    // Картинки грузятся и раскладываются по холстам ровно один раз: движение
    // ползунка меняет только порог, и пересчитывать ради него декодирование
    // снимка в несколько мегапикселей незачем.
    /** Отдаёт обе картинки потоку и там же их оставляет. */
    const handOver = async (data) => {
      const started = await createWorker();
      if (!started) return null;
      await new Promise((resolve) => {
        started.addEventListener('message', function ready({ data: message }) {
          if (message.type !== 'ready') return;
          started.removeEventListener('message', ready);
          resolve();
        });
        started.postMessage(
          {
            type: 'prepare',
            width: data.width,
            height: data.height,
            scale: data.scale,
            sizeChanged: data.sizeChanged,
            before: data.dataBefore.data.buffer,
            after: data.dataAfter.data.buffer,
          },
          [data.dataBefore.data.buffer, data.dataAfter.data.buffer],
        );
      });
      return started;
    };

    const askWorker = (threshold) =>
      new Promise((resolve, reject) => {
        const id = ++request;
        worker.addEventListener('message', function answer({ data }) {
          // Ответы на устаревшие запросы игнорируем: ползунок двигают быстрее,
          // чем считается снимок.
          if (data.type !== 'diff' || data.id !== id) return;
          worker.removeEventListener('message', answer);
          resolve({
            ...data,
            diff: new ImageData(new Uint8ClampedArray(data.diff), data.width, data.height),
          });
        });
        worker.addEventListener('error', (event) => reject(new Error(event.message)), { once: true });
        worker.postMessage({ type: 'diff', id, threshold });
      });

    const compare = async (threshold) => {
      try {
        if (!prepared) {
          meta.textContent = t('computing');
          loading ??= preparePair(pair, { repository: repositoryFromUrl() });
          prepared = await loading;
          // Буферы уходят в поток во владение, поэтому в основном остаются
          // только размеры и сами картинки — для подписи.
          worker = await handOver(prepared);
          // Видно снаружи: и в тестах, и когда разбираешь чужую жалобу.
          document.documentElement.dataset.ghpdWorker = worker ? 'on' : 'off';
        }
        const computed = worker ? await askWorker(threshold) : diffPrepared(prepared, { threshold });
        result = { ...computed, before: prepared.before, after: prepared.after };
        render();
      } catch (error) {
        meta.textContent = t('failed', error.message);
      }
    };

    // Переключатель кадров. Родные 2-up и Swipe показывают то же самое, но
    // без обрезки по изменениям и без общего масштаба — здесь «до» и «после»
    // ложатся ровно на то место, где найдена разница.
    const views = el('div', 'ghpd-views');
    const viewButtons = new Map();
    for (const name of ['before', 'after', 'diff']) {
      const button = el('button', 'ghpd-view-button');
      button.type = 'button';
      button.textContent = t(`view${name[0].toUpperCase()}${name.slice(1)}`);
      button.addEventListener('click', () => {
        shownFrame = name;
        for (const [key, node] of viewButtons) node.classList.toggle('selected', key === shownFrame);
        if (result) render();
      });
      viewButtons.set(name, button);
      views.append(button);
    }
    viewButtons.get('diff').classList.add('selected');

    let debounce = null;
    const slider = createSlider((value) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => compare(value), 150);
    });
    view.append(slider.element, views);

    return {
      element: view,
      showViews(visible) {
        views.hidden = !visible;
        // Переключатель занимает место под кадром — кадр вписываем с учётом.
        document.documentElement.style.setProperty('--ghpd-reserve', visible ? '120px' : '90px');
      },
      show() {
        view.hidden = false;
        if (!result) compare(slider.value);
      },
      hide() {
        view.hidden = true;
      },
    };
  }

  function mount() {
    const modes = document.querySelector('.js-view-modes');
    const pair = readImagePair(location.href);
    if (!modes || !pair || document.querySelector('.ghpd-view')) return;

    const panel = build(pair, modes);
    document.body.append(panel.element);

    // Настройка из окна расширения: читается асинхронно, поэтому переключатель
    // до ответа спрятан — показать его позже дешевле, чем моргнуть им.
    panel.showViews(false);
    readShowViews().then((visible) => panel.showViews(visible));
    api?.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'sync' && changes.showViews) panel.showViews(changes.showViews.newValue !== false);
    });

    // Панель режимов остаётся видимой: под неё оставляем место.
    const bar = document.querySelector('.js-render-bar') || modes.parentElement;
    const reserveForBar = () => {
      const height = Math.ceil(bar?.getBoundingClientRect().height || 40);
      document.documentElement.style.setProperty('--ghpd-bar-height', `${height}px`);
    };
    reserveForBar();
    addEventListener('resize', reserveForBar);

    const label = el('label', 'js-view-mode-item ghpd-mode-item');
    const input = el('input');
    input.type = 'radio';
    input.name = 'view-mode';
    input.value = MODE;
    label.append(input, t('modeName'));
    modes.append(label);

    const sync = () => {
      const ours = input.checked;
      for (const item of modes.querySelectorAll('.js-view-mode-item')) {
        item.classList.toggle('selected', item.querySelector('input')?.checked === true);
      }
      // Родные режимы прячем классом на документе, а не inline-стилем: какой
      // из них показать при возврате, знает скрипт GitHub, и его выбор нельзя
      // затирать — иначе назад приходят все три разом.
      document.documentElement.classList.toggle('ghpd-active', ours);
      if (ours) panel.show();
      else panel.hide();
    };

    modes.addEventListener('change', () => {
      // Запоминаем только свой выбор: на пул-реквесте с десятком картинок
      // иначе пришлось бы нажимать Pixel Diff в каждом файле заново. Уход на
      // родной режим — сигнал больше не вмешиваться.
      saveSetting(MODE_KEY, input.checked ? MODE : '');
      sync();
    });

    // Восстанавливаем выбор так же, как это сделал бы человек: щелчком.
    // Скрипт GitHub слушает то же событие и должен узнать о смене режима.
    if (readSetting(MODE_KEY) === MODE) input.click();
    else sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})(self);
