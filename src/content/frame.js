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
  const { drawCrop } = global.GhPixelDiffRender;

  const MODE = 'pixel-diff';
  /** Что показано: один из кадров или все три сразу. */
  const FRAMES = { before: 'viewBefore', after: 'viewAfter', diff: 'viewDiff', triple: 'viewTriple' };
  const FRAME_KEY = 'ghpd:frame';
  /** Порог pixelmatch: 0 — ловит даже сглаживание, 0.5 — только явные отличия. */
  const THRESHOLD_MAX = 0.5;
  const THRESHOLD_DEFAULT = 0.1;
  const THRESHOLD_KEY = 'ghpd:threshold';
  const OUTLINE_KEY = 'ghpd:outline';
  const MODE_KEY = 'ghpd:mode';
  /** Настройка из окна расширения: показывать ли переключатель кадров. */
  const SHOW_VIEWS_DEFAULT = true;
  /** Сколько ждём ответа от потока, прежде чем считать сами. */
  const WORKER_TIMEOUT = 5000;
  /**
   * Пока GitHub не задал фрейму высоту, окно внутри — узкая полоска, и кадр
   * ужимается в точку. Высоту задаёт родительская страница, и делает это,
   * когда переключается её собственный режим: наш выбор её не трогает.
   * Поэтому запомненный режим восстанавливаем не раньше, чем фрейм вырастет.
   */
  const FRAME_READY_HEIGHT = 200;
  const FRAME_READY_TIMEOUT = 4000;

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
   * Настройки: порог, рамка, выбранный режим.
   *
   * Хранятся у расширения, а не во фрейме. Хранилище фрейма для этого не
   * годится в Safari: viewscreen — третья сторона по отношению к github.com,
   * и WebKit делает такое хранилище эфемерным — всё пропадало при перезапуске
   * браузера, а на iOS практически при каждом возврате к вкладке.
   *
   * Значения читаются один раз при запуске и дальше живут в памяти: панель
   * строится синхронно, дожидаться хранилища на каждый чих незачем.
   */
  const settings = {
    [THRESHOLD_KEY]: null,
    [OUTLINE_KEY]: null,
    [MODE_KEY]: null,
    [FRAME_KEY]: null,
  };

  async function loadSettings() {
    try {
      const stored = await api?.storage?.local?.get(settings);
      if (stored) Object.assign(settings, stored);
      return;
    } catch {
      // Хранилища расширения нет — остаётся хранилище фрейма.
    }
    for (const key of Object.keys(settings)) {
      try {
        settings[key] = localStorage.getItem(key);
      } catch {
        // Приватный режим и запрет на хранилище — не повод падать.
      }
    }
  }

  function readSetting(key) {
    return settings[key];
  }

  function saveSetting(key, value) {
    settings[key] = String(value);
    try {
      const saved = api?.storage?.local?.set({ [key]: String(value) });
      if (saved) {
        saved.catch(() => {});
        return;
      }
    } catch {
      // См. ниже.
    }
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // Запрет на запись — настройка просто не переживёт перезагрузку.
    }
  }

  function readThreshold() {
    // Именно так: Number(null) — это ноль, и без проверки на пустоту порог
    // молча уезжал бы в самый левый край при первом же открытии.
    const stored = readSetting(THRESHOLD_KEY);
    const saved = Number(stored);
    if (stored !== null && stored !== '' && Number.isFinite(saved)
        && saved >= 0 && saved <= THRESHOLD_MAX) {
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
        ['vendor/pixelmatch.js', 'content/compare.js', 'content/worker.js'].map(async (path) => {
          const response = await fetch(api.runtime.getURL(path));
          // Без этой проверки страница-заглушка вместо файла склеилась бы в
          // рабочий с виду blob, и провал вылез бы вечным «Считаю…».
          if (!response.ok) throw new Error(`${path}: ${response.status}`);
          return response.text();
        }),
      );
      const url = URL.createObjectURL(new Blob(sources, { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      await greet(worker);
      return worker;
    } catch {
      return null;
    }
  }

  /**
   * Ждёт, пока поток отзовётся.
   *
   * Отдельный шаг до передачи картинок: буферы уходят во владение и обратно не
   * возвращаются, поэтому убедиться, что поток жив, нужно раньше. Не отозвался
   * за отведённое время — считаем в общем потоке, картинки при этом целы.
   */
  function greet(worker) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(new Error('worker is silent')), WORKER_TIMEOUT);
      const hello = ({ data }) => {
        if (data?.type === 'hello') stop(null);
      };
      const failed = (event) => stop(new Error(event.message || 'worker error'));
      function stop(error) {
        clearTimeout(timer);
        worker.removeEventListener('message', hello);
        worker.removeEventListener('error', failed);
        if (!error) return resolve();
        worker.terminate();
        reject(error);
      }
      worker.addEventListener('message', hello);
      worker.addEventListener('error', failed);
    });
  }

  /**
   * Разговор с потоком: один слушатель на всё время жизни вместо слушателя на
   * каждый запрос — иначе за сотню движений ползунка их накапливается сотня.
   */
  function connect(worker) {
    const pending = new Map();
    let counter = 0;

    worker.addEventListener('message', ({ data }) => {
      const waiting = pending.get(data?.id);
      if (!waiting) return;
      pending.delete(data.id);
      if (data.type === 'error') waiting.reject(new Error(data.message));
      else waiting.resolve(data);
    });

    // Поток умер — отвечать некому: отпускаем всех, кто ждёт.
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'worker error');
      for (const waiting of pending.values()) waiting.reject(error);
      pending.clear();
    });

    // transfer — то, что уходит во владение: буферы картинок копировать
    // незачем, ради этого поток и заводился.
    return (message, transfer = []) =>
      new Promise((resolve, reject) => {
        const id = ++counter;
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...message, id }, transfer);
      });
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

  function build(pair) {
    // Родной класс `view` не берём: его CSS прячет всё, кроме активного
    // режима, а видимостью своего контейнера мы управляем сами.
    const view = el('div', 'ghpd-view');
    view.hidden = true;

    // Родной класс `shell` не берём: он задаёт display: block и побеждает наш
    // flex — выравнивание по центру переставало работать, и кадр прижимался
    // к левому краю подписи.
    const shell = el('div', 'ghpd-shell');
    const canvas = el('canvas', 'ghpd-canvas');
    canvas.setAttribute('role', 'img');
    const full = document.createElement('canvas');

    // Три кадра рядом: те же данные, другая раскладка. Заводим сразу, чтобы
    // переключение между режимами не пересчитывало сравнение.
    const triple = el('div', 'ghpd-triple');
    triple.hidden = true;
    const tripleCanvases = new Map();
    for (const [name, key] of Object.entries(FRAMES)) {
      if (name === 'triple') continue;
      const item = el('div', 'ghpd-triple-item');
      const tripleCanvas = el('canvas', 'ghpd-canvas');
      tripleCanvas.setAttribute('role', 'img');
      item.append(tripleCanvas, el('span', 'ghpd-triple-label', t(key)));
      tripleCanvases.set(name, tripleCanvas);
      triple.append(item);
    }

    const meta = el('p', 'ghpd-meta');
    meta.setAttribute('aria-live', 'polite');
    const cropToggle = el('button', 'ghpd-crop-toggle');
    cropToggle.type = 'button';
    const outlineToggle = el('button', 'ghpd-outline-toggle');
    outlineToggle.type = 'button';

    shell.append(canvas, triple, meta);
    view.append(shell);

    let result = null;
    // Загрузка картинок и подъём потока — одно неделимое дело: если считать их
    // порознь, второй вход, случившийся пока идёт загрузка, заводит второй
    // поток и отдаёт ему уже отданные буферы.
    let session = null;
    let starting = null;
    let cropped = true;
    // Что показано: разница, «до», «после» или все три сразу. Выбор живёт
    // между картинками — как порог и рамка.
    let shownFrame = FRAMES[readSetting(FRAME_KEY)] ? readSetting(FRAME_KEY) : 'diff';
    // Рамка вокруг изменений — по умолчанию да: без неё правку в несколько
    // пикселей на уменьшенном кадре не найти. Но на мелком снимке она сама
    // закрывает картинку, поэтому её можно убрать, и выбор запоминается.
    let outline = readSetting(OUTLINE_KEY) !== 'off';

    const render = () => {
      const single = shownFrame !== 'triple';
      canvas.hidden = !single;
      triple.hidden = single;

      const box = single
        ? drawCrop(canvas, full, result, cropped, outline, shownFrame)
        : drawTriple();
      fitCanvas(canvas);
      const percent = result.ratio * 100;
      // «Отличий нет» и «отличия есть, но крошечные» — разные ответы.
      const shown = result.changed === 0 ? '0' : percent >= 0.01 ? percent.toFixed(2) : '<0.01';

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

    /** Рисует все три кадра сразу; размер возвращаем по разнице — она общая. */
    const drawTriple = () => {
      let box = null;
      for (const [name, target] of tripleCanvases) {
        box = drawCrop(target, full, result, cropped, outline, name);
      }
      return box;
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
    /**
     * Готовит сравнение: грузит картинки и, если получилось, отдаёт их потоку.
     * Отказ не запоминается — иначе моргнувшая сеть навсегда оставила бы
     * фрейм с одной и той же ошибкой.
     */
    const start = () => {
      starting ??= (async () => {
        const prepared = await preparePair(pair, { repository: repositoryFromUrl() });
        const worker = await createWorker();
        if (worker) {
          const ask = connect(worker);
          await ask({
            type: 'prepare',
            width: prepared.width,
            height: prepared.height,
            scale: prepared.scale,
            sizeChanged: prepared.sizeChanged,
            before: prepared.dataBefore.data.buffer,
            after: prepared.dataAfter.data.buffer,
          }, [prepared.dataBefore.data.buffer, prepared.dataAfter.data.buffer]);
          // Видно снаружи: и в тестах, и когда разбираешь чужую жалобу.
          document.documentElement.dataset.ghpdWorker = 'on';
          return { prepared, worker, ask };
        }
        document.documentElement.dataset.ghpdWorker = 'off';
        return { prepared, worker: null, ask: null };
      })().catch((error) => {
        starting = null;
        throw error;
      });
      return starting;
    };

    const compare = async (threshold) => {
      try {
        if (!session) {
          meta.textContent = t('computing');
          session = await start();
        }
        const computed = session.ask
          ? await session.ask({ type: 'diff', threshold })
          : diffPrepared(session.prepared, { threshold });
        result = { ...computed, before: session.prepared.before, after: session.prepared.after };
        // Из потока разница приходит буфером — обратно в картинку её
        // собирает тот, кто рисует.
        if (computed.diff instanceof ArrayBuffer) {
          result.diff = new ImageData(
            new Uint8ClampedArray(computed.diff),
            computed.width,
            computed.height,
          );
        }
        render();
      } catch (error) {
        // Картинки уже у потока, и если он умер — своих копий не осталось.
        // Значит начинать надо заново: браузер отдаст их из кэша.
        session = null;
        starting = null;
        meta.textContent = t('failed', error.message) || error.message;
      }
    };

    // Переключатель кадров. Родные 2-up и Swipe показывают то же самое, но
    // без обрезки по изменениям и без общего масштаба — здесь «до» и «после»
    // ложатся ровно на то место, где найдена разница.
    const views = el('div', 'ghpd-views');
    const viewButtons = new Map();
    for (const [name, key] of Object.entries(FRAMES)) {
      const button = el('button', 'ghpd-view-button');
      button.type = 'button';
      button.textContent = t(key);
      button.setAttribute('aria-pressed', String(name === shownFrame));
      button.addEventListener('click', () => {
        shownFrame = name;
        saveSetting(FRAME_KEY, name);
        for (const [key, node] of viewButtons) {
          node.classList.toggle('selected', key === shownFrame);
          node.setAttribute('aria-pressed', String(key === shownFrame));
        }
        if (result) render();
      });
      viewButtons.set(name, button);
      views.append(button);
    }
    viewButtons.get(shownFrame).classList.add('selected');

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
        // Переключатель занимает место под кадром — размер запаса знает CSS.
        document.documentElement.classList.toggle('ghpd-with-views', visible);
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

    const panel = build(pair);
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
      // иначе пришлось бы нажимать наш режим в каждом файле заново. Уход на
      // родной режим — сигнал больше не вмешиваться.
      saveSetting(MODE_KEY, input.checked ? MODE : '');
      sync();
    });

    if (readSetting(MODE_KEY) !== MODE) {
      sync();
      return;
    }

    // Восстанавливаем выбор так же, как это сделал бы человек: щелчком.
    // Скрипт GitHub слушает то же событие и должен узнать о смене режима.
    const restore = () => input.click();
    if (innerHeight >= FRAME_READY_HEIGHT) {
      restore();
      return;
    }

    const waitForHeight = () => {
      if (innerHeight < FRAME_READY_HEIGHT) return;
      stopWaiting();
      restore();
    };
    // Ждать вечно нельзя: у маленькой картинки фрейм и не должен вырасти.
    const timer = setTimeout(() => {
      stopWaiting();
      restore();
    }, FRAME_READY_TIMEOUT);
    function stopWaiting() {
      clearTimeout(timer);
      removeEventListener('resize', waitForHeight);
    }
    addEventListener('resize', waitForHeight);
  }

  // Настройки читаются до сборки панели: иначе ползунок и режим успели бы
  // моргнуть значениями по умолчанию.
  const started = loadSettings();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => started.then(mount));
  } else {
    started.then(mount);
  }
})(self);
