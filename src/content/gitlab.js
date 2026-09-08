// Режим Pixel Diff в просмотрщике картинок GitLab.
//
// Устройство то же, что у GitHub: четвёртая кнопка в родном ряду режимов,
// своя панель вместо родного кадра, всё остальное GitLab делает сам. Отличия
// в оболочке, а не в сути:
//
//   — картинок на странице много, и GitLab подгружает их по мере прокрутки,
//     поэтому за появлением новых следит наблюдатель;
//   — ряд режимов рисует Vue, и он может перерисовать список; нашу кнопку в
//     таком случае возвращаем на место;
//   — картинки лежат на том же домене, поэтому холст читается без CORS.
(function (global) {
  'use strict';

  const { preparePair, diffPrepared } = global.GhPixelDiff;
  const { drawCrop } = global.GhPixelDiffRender;
  const { create: createWorker } = global.GhPixelDiffWorker;
  const { t, plural } = global.GhPixelDiffI18n;
  const api = global.browser ?? global.chrome;

  /** Что показано: один из кадров или все три сразу. */
  const FRAMES = { before: 'viewBefore', after: 'viewAfter', diff: 'viewDiff', triple: 'viewTriple' };
  const THRESHOLD_MAX = 0.5;
  const THRESHOLD_DEFAULT = 0.1;
  const THRESHOLD_KEY = 'ghpd:threshold';
  const OUTLINE_KEY = 'ghpd:outline';
  const FRAME_KEY = 'ghpd:frame';
  const SHOW_VIEWS_DEFAULT = true;
  /** Пометка на уже обработанном просмотрщике: наблюдатель приходит не раз. */
  const MARK = 'ghpdReady';

  const settings = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * Настройки живут в хранилище расширения: страница у GitLab своя на каждый
   * проект, а выбор порога и обводки должен переживать переходы.
   */
  async function loadSettings() {
    try {
      const stored = await api?.storage?.local?.get({
        [THRESHOLD_KEY]: null,
        [OUTLINE_KEY]: null,
        [FRAME_KEY]: null,
      });
      for (const [key, value] of Object.entries(stored ?? {})) {
        if (value != null) settings.set(key, value);
      }
    } catch {
      // Нет хранилища — работаем со значениями по умолчанию.
    }
  }

  function readSetting(key) {
    return settings.get(key) ?? null;
  }

  function saveSetting(key, value) {
    settings.set(key, value);
    try {
      api?.storage?.local?.set({ [key]: value });
    } catch {
      // Не сохранилось — не повод ломать сравнение.
    }
  }

  function readThreshold() {
    const stored = Number(readSetting(THRESHOLD_KEY));
    return Number.isFinite(stored) && stored >= 0 && stored <= THRESHOLD_MAX
      ? stored
      : THRESHOLD_DEFAULT;
  }

  async function readShowViews() {
    try {
      const stored = await api?.storage?.sync?.get({ showViews: SHOW_VIEWS_DEFAULT });
      return stored?.showViews ?? SHOW_VIEWS_DEFAULT;
    } catch {
      return SHOW_VIEWS_DEFAULT;
    }
  }

  /**
   * Обе версии картинки. В любом из родных режимов они лежат под классами
   * `deleted` и `added` — GitLab метит ими старую и новую.
   */
  function readImagePair(viewer) {
    const before = viewer.querySelector('.deleted img')?.src;
    const after = viewer.querySelector('.added img')?.src;
    return before && after ? { before, after } : null;
  }

  /** Панель сравнения: холсты, подпись, ползунок, переключатель кадров. */
  function buildPanel(pair, showViews) {
    const panel = el('div', 'ghpd-panel');
    const shell = el('div', 'ghpd-shell');
    const canvas = el('canvas', 'ghpd-canvas');
    const triple = el('div', 'ghpd-triple');
    const meta = el('p', 'ghpd-meta', t('computing'));
    const full = document.createElement('canvas');

    triple.hidden = true;
    const tripleCanvases = ['before', 'after', 'diff'].map((name) => {
      const item = el('div', 'ghpd-triple-item');
      const target = el('canvas', 'ghpd-canvas');
      item.append(target, el('div', 'ghpd-triple-label', t(FRAMES[name])));
      triple.append(item);
      return [name, target];
    });

    const cropToggle = el('button', 'ghpd-crop-toggle');
    const outlineToggle = el('button', 'ghpd-outline-toggle');
    cropToggle.type = 'button';
    outlineToggle.type = 'button';

    const controls = el('div', 'ghpd-controls');
    const slider = el('input', 'ghpd-slider');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(THRESHOLD_MAX);
    slider.step = '0.01';
    slider.value = String(readThreshold());
    slider.setAttribute('aria-label', t('thresholdLabel'));
    controls.title = t('thresholdHint');
    controls.append(
      el('span', 'ghpd-mark ghpd-mark-small'),
      slider,
      el('span', 'ghpd-mark ghpd-mark-large'),
    );

    const views = el('div', 'ghpd-views');
    views.hidden = !showViews;

    shell.append(canvas, triple, meta, controls, views);
    panel.append(shell);

    let result = null;
    let session = null;
    let starting = null;
    let cropped = true;
    let shownFrame = FRAMES[readSetting(FRAME_KEY)] ? readSetting(FRAME_KEY) : 'diff';
    let outline = readSetting(OUTLINE_KEY) !== 'off';

    const viewButtons = new Map();
    for (const [name, key] of Object.entries(FRAMES)) {
      const button = el('button', 'ghpd-view-button', t(key));
      button.type = 'button';
      button.setAttribute('aria-pressed', String(name === shownFrame));
      button.addEventListener('click', () => {
        shownFrame = name;
        saveSetting(FRAME_KEY, name);
        for (const [other, node] of viewButtons) {
          node.classList.toggle('selected', other === shownFrame);
          node.setAttribute('aria-pressed', String(other === shownFrame));
        }
        if (result) render();
      });
      viewButtons.set(name, button);
      views.append(button);
    }
    viewButtons.get(shownFrame).classList.add('selected');

    function render() {
      const single = shownFrame !== 'triple';
      canvas.hidden = !single;
      triple.hidden = single;

      let box;
      if (single) {
        box = drawCrop(canvas, full, result, cropped, outline, shownFrame);
      } else {
        for (const [name, target] of tripleCanvases) {
          box = drawCrop(target, full, result, cropped, outline, name);
        }
      }

      const percent = result.ratio * 100;
      // «Отличий нет» и «отличия есть, но крошечные» — разные ответы.
      const shown = result.changed === 0 ? '0' : percent >= 0.01 ? percent.toFixed(2) : '<0.01';

      meta.replaceChildren(
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
      if (result.scale > 1) meta.append(` · ${t('rasterized', result.width, result.height)}`);
      if (result.sizeChanged) {
        meta.append(
          ` · ${t(
            'sizeChanged',
            `${result.before.naturalWidth}×${result.before.naturalHeight}`,
            `${result.after.naturalWidth}×${result.after.naturalHeight}`,
          )}`,
        );
      }
    }

    cropToggle.addEventListener('click', () => {
      cropped = !cropped;
      render();
    });

    outlineToggle.addEventListener('click', () => {
      outline = !outline;
      saveSetting(OUTLINE_KEY, outline ? 'on' : 'off');
      render();
    });

    /**
     * Готовит сравнение: грузит картинки и, если получилось, отдаёт их потоку.
     * Отказ не запоминается — иначе моргнувшая сеть навсегда оставила бы
     * панель с одной и той же ошибкой.
     */
    const start = () => {
      starting ??= (async () => {
        const prepared = await preparePair(pair);
        const spawned = await createWorker();
        if (spawned) {
          const { ask } = spawned;
          await ask(
            {
              type: 'prepare',
              width: prepared.width,
              height: prepared.height,
              scale: prepared.scale,
              sizeChanged: prepared.sizeChanged,
              before: prepared.dataBefore.data.buffer,
              after: prepared.dataAfter.data.buffer,
            },
            [prepared.dataBefore.data.buffer, prepared.dataAfter.data.buffer],
          );
          // Видно снаружи: и в тестах, и когда разбираешь чужую жалобу.
          document.documentElement.dataset.ghpdWorker = 'on';
          return { prepared, ask };
        }
        document.documentElement.dataset.ghpdWorker = 'off';
        return { prepared, ask: null };
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
        // Из потока разница приходит буфером — в ImageData её собираем здесь.
        if (computed.diff instanceof ArrayBuffer) {
          result.diff = new ImageData(
            new Uint8ClampedArray(computed.diff),
            computed.width,
            computed.height,
          );
        }
        render();
      } catch (error) {
        session = null;
        starting = null;
        meta.textContent = t('failed', error.message) || error.message;
      }
    };

    let debounce = null;
    slider.addEventListener('input', () => {
      saveSetting(THRESHOLD_KEY, slider.value);
      clearTimeout(debounce);
      debounce = setTimeout(() => compare(Number(slider.value)), 150);
    });

    return { element: panel, compare: () => compare(Number(slider.value)) };
  }

  /**
   * Встраивает наш режим в один просмотрщик.
   * Родной кадр не удаляем и не трогаем: его показом и содержимым управляет
   * Vue, а мы лишь прячем его на время своего режима.
   */
  function attach(viewer, showViews) {
    const menu = viewer.querySelector('.view-modes-menu');
    const image = viewer.querySelector('.image');
    if (!menu || !image || viewer.dataset[MARK]) return;
    viewer.dataset[MARK] = 'on';

    const item = el('li', 'ghpd-mode-item', t('modeName'));
    let panel = null;
    // Включён ли наш режим, держим у себя, а не читаем из класса: класс
    // `active` расставляет Vue, и к моменту, когда наш обработчик всплывёт до
    // списка, он уже снят со всех пунктов — включая наш.
    let active = false;

    const deactivate = () => {
      active = false;
      item.classList.remove('active');
      image.hidden = false;
      if (panel) panel.element.hidden = true;
    };

    // Нажали на родной пункт — уступаем ему место.
    menu.addEventListener('click', (event) => {
      if (!item.contains(event.target) && active) deactivate();
    });

    item.addEventListener('click', () => {
      if (active) return;
      active = true;
      for (const other of menu.children) other.classList.remove('active');
      item.classList.add('active');
      image.hidden = true;

      if (!panel) {
        const pair = readImagePair(viewer);
        if (!pair) {
          // Картинок не нашлось — молчать нельзя, иначе это выглядит поломкой.
          panel = { element: el('p', 'ghpd-meta', t('failed', 'no images')), compare: () => {} };
          image.after(panel.element);
          return;
        }
        panel = buildPanel(pair, showViews);
        image.after(panel.element);
      }
      panel.element.hidden = false;
      panel.compare();
    });

    menu.append(item);

    // Vue перерисовывает список режимов, когда меняется активный, и может
    // выбросить чужой узел. Возвращаем его на место — иначе кнопка исчезает
    // ровно после того, как ей воспользовались.
    new MutationObserver(() => {
      if (!item.isConnected) menu.append(item);
    }).observe(menu, { childList: true });
  }

  async function mount() {
    const showViews = await readShowViews();
    await loadSettings();

    const scan = () => {
      for (const viewer of document.querySelectorAll('.diff-viewer')) {
        if (viewer.querySelector('.view-modes-menu')) attach(viewer, showViews);
      }
    };

    scan();
    // Файлы в мердж-реквесте подгружаются по мере прокрутки, а сам список
    // перерисовывается при смене вкладки — одного прохода мало.
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})(self);
