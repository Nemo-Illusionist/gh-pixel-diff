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
  const { attachProbe, attachZoom, createZoom, drawCrop, dressFrame, frameFileName, holdStage, saveCanvas,
    zoomLabel, createMenu, twoWayLabel } = global.GhPixelDiffRender;
  const { create: createWorker } = global.GhPixelDiffWorker;
  const { t, plural, locale } = global.GhPixelDiffI18n;
  const api = global.browser ?? global.chrome;

  /** Что показано: один из кадров или все три сразу. */
  const FRAMES = {
    before: 'viewBefore',
    after: 'viewAfter',
    diff: 'viewDiff',
    overlay: 'viewOverlay',
    triple: 'viewTriple',
  };
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

  /** Цвета разницы: свои, если их поменяли в настройках. */
  const colors = { ...global.GhPixelDiff.COLORS };
  /** Сшивать ли сдвинутые строки — бета, по умолчанию выключено. */
  const beta = { on: false };

  async function readColors() {
    try {
      const stored = await api?.storage?.sync?.get({ colors: null, beta: false });
      if (stored?.colors) Object.assign(colors, stored.colors);
      beta.on = stored?.beta === true;
    } catch {
      // Хранилища нет — остаётся обычная пара и сравнение без сшивания.
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
    canvas.title = t('zoomHint');
    const triple = el('div', 'ghpd-triple');
    const meta = el('p', 'ghpd-meta', t('computing'));
    // Пиксель под курсором. Живой области здесь не место: строка меняется на
    // каждое движение мыши.
    const probe = el('p', 'ghpd-probe');
    const full = document.createElement('canvas');

    triple.hidden = true;
    const triplePlates = new Map();
    const tripleCanvases = ['before', 'after', 'diff'].map((name) => {
      // Каждый из трёх — такая же пластина, как одиночный кадр: подпись
      // сверху, размер снизу, цвет рамки по версии.
      const item = el('div', 'ghpd-triple-item ghpd-plate');
      const target = el('canvas', 'ghpd-canvas');
      const itemLabel = el('div', 'ghpd-plate-label', t(FRAMES[name]));
      const itemSize = el('p', 'ghpd-plate-size');
      item.append(itemLabel, target, itemSize);
      triplePlates.set(name, { plate: item, label: itemLabel, size: itemSize });
      triple.append(item);
      return [name, target];
    });

    const cropToggle = el('button', 'ghpd-crop-toggle');
    const outlineToggle = el('button', 'ghpd-outline-toggle');
    const zoomReset = el('button', 'ghpd-zoom-reset');
    cropToggle.type = 'button';
    outlineToggle.type = 'button';
    zoomReset.type = 'button';
    // Подписи у кнопки две, а ширина одна — по большей: иначе «весь кадр» и
    // «фрагмент» двигали бы всё, что правее, от нажатия к нажатию.
    const showCropLabel = twoWayLabel(cropToggle, t('showFullFrame'), t('showChangesOnly'));
    // Переходы между местами изменений: правки часто в разных концах кадра,
    // и обрезка по всем сразу — это опять весь кадр.
    const save = el('button', 'ghpd-save', t('saveFrame'));
    save.type = 'button';
    const prevChange = el('button', 'ghpd-cluster-step', '‹');
    const nextChange = el('button', 'ghpd-cluster-step', '›');
    for (const [button, key] of [[prevChange, 'clusterPrev'], [nextChange, 'clusterNext']]) {
      button.type = 'button';
      button.title = t(key);
      button.setAttribute('aria-label', t(key));
    }
    // Переходы собраны в одну группу и живут в строке управления, а не в
    // подписи: подпись пересобирается на каждый пересчёт, и кнопки в ней
    // переезжали с места на место вслед за длиной числа.
    const nav = el('div', 'ghpd-nav');
    const navLabel = el('span', 'ghpd-nav-label');
    nav.append(prevChange, navLabel, nextChange);

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

    // Порог, рамка и сохранение — под «⋯»: нужны они не каждый раз, а место
    // под кадром занимали всегда. Внизу остаётся то, ради чего панель
    // открывают: какой кадр показать и куда в нём смотреть.
    const menu = createMenu(t('moreControls'));
    menu.panel.append(controls, outlineToggle, save);

    // Строка управления: состав постоянный, меняется только видимость —
    // кнопки не переезжают с места на место.
    const bar = el('div', 'ghpd-bar');
    bar.append(views, cropToggle, zoomReset, nav, menu.element);

    // Кадр живёт в сцене: её размер не зависит от того, что в ней показано,
    // и подпись со строкой управления не ездят вслед за высотой кадра.
    // Кадр в «пластине» по образцу GitHub: подпись сверху, размер снизу,
    // цветная рамка на самом холсте. Обе строки держат высоту всегда, даже
    // пустые, — переключение кадров не должно ничего дёргать.
    const plate = el('div', 'ghpd-plate');
    const plateLabel = el('span', 'ghpd-plate-label');
    const plateSize = el('p', 'ghpd-plate-size');
    plate.append(plateLabel, canvas, plateSize);

    const stage = el('div', 'ghpd-stage');
    stage.append(plate, triple);
    shell.append(stage, meta, probe, bar);
    panel.append(shell);

    let result = null;
    let session = null;
    let starting = null;
    let cropped = true;
    // Спрятанный переключатель не должен запирать в том кадре, который был
    // выбран до него: из «3-up» иначе не выйти, а сохранение в нём погашено.
    let shownFrame = FRAMES[readSetting(FRAME_KEY)] && showViews ? readSetting(FRAME_KEY) : 'diff';
    let outline = readSetting(OUTLINE_KEY) !== 'off';
    // Увеличение, в отличие от порога и рамки, не запоминается: это не
    // настройка, а взгляд на конкретное место конкретного кадра.
    const zoom = createZoom(() => {
      if (result) render();
    });
    attachZoom(canvas, zoom);
    attachProbe(canvas, probe, zoom, () => result);
    zoomReset.addEventListener('click', () => zoom.reset());
    // Какое из мест изменений выбрано; -1 — все сразу, и так по умолчанию.
    // Обрезка по всем изменениям — прежний ответ панели, и терять его ради
    // переходов нельзя: чаще всего правка одна, и ходить там некуда.
    //
    // Номер, а не сам прямоугольник: при каждом пересчёте порога места
    // считаются заново.
    let focusIndex = -1;

    /** Переход к соседнему месту изменений — по кругу. */
    const stepChange = (delta) => {
      const total = result?.clusters?.length ?? 0;
      if (total < 2) return;
      // Состояний на одно больше, чем мест: «все» — такое же состояние, и
      // круг через него проходит, а не мимо.
      focusIndex = ((focusIndex + 1 + delta + total + 1) % (total + 1)) - 1;
      if (focusIndex < 0) {
        zoom.reset();
        render();
        return;
      }
      // В полном кадре переход не меняет обрезку — значит должен навести
      // увеличение, иначе нажатие выглядит как ничего не делающее.
      zoom.lookAt(result.clusters[focusIndex]);
      render();
    };
    save.addEventListener('click', () => {
      // Имя берём из адреса картинки: у GitLab это путь файла в репозитории.
      saveCanvas(canvas, frameFileName(pair.after, shownFrame), () => {
        meta.append(` · ${t('saveFailed')}`);
      });
    });

    prevChange.addEventListener('click', () => stepChange(-1));
    nextChange.addEventListener('click', () => stepChange(1));

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

      const clusters = result.clusters ?? [];
      if (focusIndex >= clusters.length) focusIndex = -1;
      // Пока место одно, выбирать не из чего — и обрезка остаётся прежней.
      const focus = clusters.length > 1 && focusIndex >= 0 ? clusters[focusIndex] : null;

      let box;
      if (single) {
        box = drawCrop(canvas, full, result, { frame: shownFrame, cropped, outline, zoom, focus, colors });
        canvas.classList.toggle('ghpd-zoomed', zoom.scale > 1);
      } else {
        for (const [name, target] of tripleCanvases) {
          box = drawCrop(target, full, result, { frame: name, cropped, outline, focus, colors });
        }
      }

      holdStage(stage, single ? plate : triple, canvas);

      const percent = result.ratio * 100;
      // «Отличий нет» и «отличия есть, но крошечные» — разные ответы.
      const shown = result.changed === 0 ? '0' : percent >= 0.01 ? percent.toFixed(2) : '<0.01';

      // Подпись — только факты: сколько изменилось и на чём это считано.
      // Всё, чем панель управляют, живёт строкой ниже и стоит на месте.
      meta.replaceChildren(
        el('strong', null, plural('pixels', result.changed)),
        ` · ${t('shareOfFrame', shown)}`,
      );
      // Сдвиг называем словами: «весь кадр красный» и «вставлено 24 строки» —
      // разные ответы, даже когда картинка одна и та же.
      const shift = [
        result.inserted ? `+${result.inserted.toLocaleString(locale())}` : '',
        result.removed ? `−${result.removed.toLocaleString(locale())}` : '',
      ].filter(Boolean).join(' ');
      if (clusters.length > 1) meta.append(` · ${plural('places', clusters.length)}`);
      if (shift) meta.append(` · ${t('rowsShifted', shift)}`);
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

      // Кадр одет по образцу GitHub: «до» в красной рамке, «после» в зелёной,
      // подпись сверху, размер картинки снизу. Размер — натуральный, а не
      // показанный: фрагмент и увеличение меняют то, что на экране, но не то,
      // какого размера файл.
      const side = shownFrame === 'before' || shownFrame === 'after' ? shownFrame : null;
      const own = side === 'after' ? result.after : result.before;
      const other = side === 'after' ? result.before : result.after;
      dressFrame(
        { plate, label: plateLabel, size: plateSize },
        {
          side: single ? side : null,
          // Именуем только «до» и «после», как GitHub: над разницей подпись
        // лишь повторила бы кнопку под ней. Высоту строка держит всегда.
        name: single && side ? t(FRAMES[shownFrame]) : '',
          width: own?.naturalWidth,
          height: own?.naturalHeight,
          other: other && { width: other.naturalWidth, height: other.naturalHeight },
          units: { width: t('frameWidth'), height: t('frameHeight') },
        },
      );

      // Три кадра рядом — те же пластины: «до» красное, «после» зелёное,
      // разница нейтральна.
      for (const [name, parts] of triplePlates) {
        const mine = name === 'after' ? result.after : result.before;
        const opposite = name === 'after' ? result.before : result.after;
        dressFrame(parts, {
          side: name === 'before' || name === 'after' ? name : null,
          name: t(FRAMES[name]),
          width: mine?.naturalWidth,
          height: mine?.naturalHeight,
          other: opposite && { width: opposite.naturalWidth, height: opposite.naturalHeight },
          units: { width: t('frameWidth'), height: t('frameHeight') },
        });
      }

      // «все» или «2/5»: короткая подпись стоит на месте, а длинная фраза
      // ездила бы вслед за своей длиной и таскала бы за собой «⋯».
      nav.hidden = clusters.length < 2;
      navLabel.textContent =
        focusIndex < 0 ? t('clusterAll') : `${focusIndex + 1}/${clusters.length}`;
      navLabel.title =
        focusIndex < 0
          ? plural('places', clusters.length)
          : t('clusterPosition', focusIndex + 1, clusters.length);
      cropToggle.hidden = !result.bounds;
      if (result.bounds) {
        showCropLabel(cropped);
        cropToggle.title = t('cropSize', box.width, box.height);
      }
      // Увеличение видно по кадру, но не видно, насколько оно велико и как
      // вернуться обратно, — поэтому кнопка сброса называет его вслух.
      zoomReset.hidden = !single || zoom.scale <= 1;
      if (!zoomReset.hidden) zoomReset.textContent = t('zoomReset', zoomLabel(zoom.scale, locale()));
      // Состав меню постоянный: то, что сейчас не к месту, гаснет, а не
      // пропадает. Иначе в кадре «3-up» под «⋯» оставался один ползунок, и
      // меню выглядело сломанным.
      // Рамка рисуется только в полном кадре — в обрезке ей нечего делать.
      outlineToggle.disabled = cropped || !result.bounds;
      outlineToggle.textContent = outline ? t('hideOutline') : t('showOutline');
      // Сохранять есть что только в одиночном кадре: три кадра рядом лежат
      // на трёх холстах, и «эта картинка» перестаёт быть одной картинкой.
      save.disabled = !single;
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
              common: prepared.common,
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
          ? await session.ask({ type: 'diff', threshold, colors, beta: beta.on })
          : diffPrepared(session.prepared, { threshold, colors, beta: beta.on });

        result = { ...computed, before: session.prepared.before, after: session.prepared.after };
        // Из потока разница приходит буфером — в ImageData её собираем здесь.
        // Из потока карта строк приходит буфером — собираем обратно.
        if (computed.rows instanceof ArrayBuffer) result.rows = new Int32Array(computed.rows);
        if (computed.mask instanceof ArrayBuffer) {
          result.mask = new ImageData(
            new Uint8ClampedArray(computed.mask),
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

  /**
   * Правда ли перед нами GitLab.
   *
   * Доступ к своему серверу человек выдаёт руками, а `.diff-viewer` и
   * `.view-modes-menu` — классы общие: ошибиться адресом легко, и на чужой
   * странице расширение не должно трогать ничего. `data-page` — рельсовый
   * идентификатор страницы; он есть на каждой странице GitLab, своей и
   * витринной, а картинки в диффе бывают только в разделе `projects:`.
   */
  function isGitLab() {
    return Boolean(document.body?.dataset?.page?.startsWith('projects:'));
  }

  async function mount() {
    if (!isGitLab()) return;

    const showViews = await readShowViews();
    // Язык и цвета — до сборки панелей: иначе надписи моргнули бы браузерными,
    // а первое сравнение посчиталось бы обычной парой цветов.
    await Promise.all([loadSettings(), readColors(), global.GhPixelDiffLocale?.apply()]);

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
