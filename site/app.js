// Отдельная страница: две картинки руками — та же разница, что во фрейме.
//
// Логика сравнения и отрисовки взята из расширения без изменений; здесь
// только оболочка: как картинки попадают внутрь и как выглядит панель.
(function (global) {
  'use strict';

  const { preparePair, diffPrepared } = global.GhPixelDiff;
  const { attachProbe, attachZoom, createZoom, drawCrop, frameFileName, frameSize, holdStage, saveCanvas,
    zoomLabel, createMenu, twoWayLabel } = global.GhPixelDiffRender;
  const { t, plural, locale } = global.GhPixelDiffI18n;

  const FRAMES = {
    before: 'viewBefore',
    after: 'viewAfter',
    diff: 'viewDiff',
    overlay: 'viewOverlay',
    triple: 'viewTriple',
  };
  /** Сколько ждём ответа от потока, прежде чем считать сами. */
  const WORKER_TIMEOUT = 5000;
  /** Задержка после движения ползунка: пересчёт дорогой, а тянут его подряд. */
  const SLIDER_DELAY = 150;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /**
   * Настройки страницы — в localStorage, а не в хранилище расширения: его
   * здесь нет. Отказ хранилища не должен уносить с собой страницу, поэтому
   * каждое обращение обёрнуто: в приватном окне чтение и запись бросают.
   */
  const settings = {
    read(key, fallback = null) {
      try {
        const stored = global.localStorage?.getItem(key);
        return stored === null || stored === undefined ? fallback : JSON.parse(stored);
      } catch {
        return fallback;
      }
    },
    write(key, value) {
      try {
        global.localStorage?.setItem(key, JSON.stringify(value));
      } catch {
        // Не сохранилось — выбор всё равно действует до конца этого визита.
      }
    },
  };

  const THRESHOLD_KEY = 'ghpd:threshold';
  const OUTLINE_KEY = 'ghpd:outline';
  const FRAME_KEY = 'ghpd:frame';
  const COLORS_KEY = 'ghpd:colors';
  const BETA_KEY = 'ghpd:beta';
  const VIEWS_KEY = 'ghpd:showViews';

  /** Надписи ставим отсюда: при смене языка их придётся переставить заново. */
  function label() {
    for (const node of document.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n);
    }
    document.documentElement.lang = global.__GHPD_LOCALE ?? 'en';
    document.title = `${t('siteTitle')} — ${t('modeName')}`;
  }

  label();

  const panel = document.querySelector('#panel');
  const stage = document.querySelector('.panel-frame');
  const canvas = document.querySelector('#canvas');
  const plate = document.querySelector('#plate');
  const plateName = document.querySelector('#plate-name');
  const triple = document.querySelector('#triple');
  const meta = document.querySelector('#meta');
  const failure = document.querySelector('#failure');
  const slider = document.querySelector('#threshold');
  const views = document.querySelector('#views');

  slider.setAttribute('aria-label', t('thresholdLabel'));
  slider.title = t('thresholdHint');
  // Порог помнится между парами. Проверяем границы: в хранилище может лежать
  // что угодно, а Number(null) — это ноль, то есть самый левый край.
  const savedThreshold = Number(settings.read(THRESHOLD_KEY));
  if (Number.isFinite(savedThreshold) && savedThreshold >= 0 && savedThreshold <= Number(slider.max)) {
    slider.value = String(savedThreshold);
  }

  // Холст с кадром целиком — один на страницу: заводить его заново на каждую
  // отрисовку значит тратить десятки мегабайт при каждом движении ползунка.
  const full = document.createElement('canvas');

  /** Что лежит в половинах и что из этого посчитано. */
  const files = { before: null, after: null };
  let session = null;
  let result = null;
  // Порог, рамка и выбранный кадр помнятся между парами — как в расширении:
  // на десяти картинках подряд незачем настраивать одно и то же заново.
  let shownFrame = FRAMES[settings.read(FRAME_KEY)] ? settings.read(FRAME_KEY) : 'diff';
  let cropped = true;
  let outline = settings.read(OUTLINE_KEY, true) !== false;
  // Цвета разницы и бета — те же, что в настройках расширения: по умолчанию
  // один красный, направление и сшивание включаются руками.
  const colors = { ...global.GhPixelDiff.COLORS, ...(settings.read(COLORS_KEY) ?? {}) };
  let beta = settings.read(BETA_KEY, false) === true;

  const cropToggle = el('button', 'ghpd-crop-toggle');
  const outlineToggle = el('button', 'ghpd-outline-toggle');
  const zoomReset = el('button', 'ghpd-zoom-reset');
  cropToggle.type = 'button';
  outlineToggle.type = 'button';
  zoomReset.type = 'button';
  // Подписи у кнопки две, а ширина одна — по большей: иначе «весь кадр» и
  // «фрагмент» двигали бы всё, что правее, от нажатия к нажатию.
  let showCropLabel = twoWayLabel(cropToggle, t('showFullFrame'), t('showChangesOnly'));
  // Переходы между местами изменений: правки часто в разных концах кадра, и
  // обрезка по всем сразу — это опять весь кадр.
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

  // Порог, рамка и сохранение — под «⋯»: нужны они не каждый раз, а место под
  // кадром занимали всегда. Внизу остаётся то, ради чего страницу открывают:
  // какой кадр показать и куда в нём смотреть.
  const menu = createMenu(t('moreControls'));
  const controls = document.querySelector('#controls');
  controls.hidden = false;
  menu.panel.append(controls, outlineToggle, save);
  document.querySelector('#bar').append(cropToggle, zoomReset, nav, menu.element);

  // Увеличение живёт ровно столько, сколько показанная пара: это не
  // настройка, а взгляд на конкретное место конкретного кадра.
  const zoom = createZoom(() => {
    if (result) render();
  });
  canvas.title = t('zoomHint');
  attachZoom(canvas, zoom);
  attachProbe(canvas, document.querySelector('#probe'), zoom, () => result);
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
    saveCanvas(canvas, frameFileName(files.after?.name, shownFrame), () => {
      meta.append(` · ${t('saveFailed')}`);
    });
  });

  prevChange.addEventListener('click', () => stepChange(-1));
  nextChange.addEventListener('click', () => stepChange(1));

  const tripleLabels = new Map();
  const triplePlates = new Map();
  const tripleCanvases = ['before', 'after', 'diff'].map((name) => {
    // Имя сверху, размер снизу — как в 2-up у GitHub.
    const item = el('div', 'ghpd-triple-item');
    const target = el('canvas', 'ghpd-canvas');
    const caption = el('div', 'ghpd-plate-label', t(FRAMES[name]));
    const itemSize = el('div', 'ghpd-triple-size');
    if (name === 'before' || name === 'after') target.dataset.side = name;
    tripleLabels.set(name, caption);
    triplePlates.set(name, { name: caption, size: itemSize });
    item.append(caption, target, itemSize);
    triple.append(item);
    return [name, target];
  });

  const viewButtons = new Map();
  for (const [name, key] of Object.entries(FRAMES)) {
    const button = el('button', 'ghpd-view-button', t(key));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(name === shownFrame));
    button.addEventListener('click', () => {
      shownFrame = name;
      settings.write(FRAME_KEY, name);
      for (const [other, node] of viewButtons) {
        node.classList.toggle('selected', other === name);
        node.setAttribute('aria-pressed', String(other === name));
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

    // Подпись — только факты: сколько изменилось и на чём это считано. Всё,
    // чем панель управляют, живёт строкой ниже и стоит на месте.
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

    // Кадр одет по образцу GitHub: имя версии над кадром, «до» в красной
    // рамке, «после» в зелёной.
    const side = single && (shownFrame === 'before' || shownFrame === 'after')
      ? shownFrame
      : null;
    if (side) canvas.dataset.side = side;
    else delete canvas.dataset.side;
    plateName.className = `ghpd-plate-label${side ? ` ghpd-side-${side}` : ''}`;
    // В тройке пластина ни к чему: там у каждого кадра своё имя.
    plate.hidden = !single;
    // Имя стоит только над «до» и «после» — как у GitHub, где подписаны
    // ровно две версии. Над разницей и наложением оно повторило бы кнопку
    // под кадром, а строку эту кадр оплачивает своей высотой.
    plate.classList.toggle('ghpd-plate-named', Boolean(side));
    plateName.hidden = !side;
    plateName.textContent = side ? t(FRAMES[shownFrame]) : '';

    // Размер картинки — снизу, как у GitHub, но в строке фактов, которая и
    // так есть: своя строка отняла бы у кадра ещё двадцать пикселей ради
    // того, что бывает только у двух кадров из пяти.
    //
    // Размер натуральный, а не показанный: фрагмент и увеличение меняют то,
    // что на экране, но не то, какого размера файл.
    if (side) {
      const own = side === 'after' ? result.after : result.before;
      const other = side === 'after' ? result.before : result.after;
      meta.append(' · ');
      meta.append(
        ...frameSize({
          width: own.naturalWidth,
          height: own.naturalHeight,
          other: other && { width: other.naturalWidth, height: other.naturalHeight },
          units: { width: t('frameWidth'), height: t('frameHeight') },
        }),
      );
      for (const node of meta.querySelectorAll('.ghpd-size-changed')) {
        node.classList.add(`ghpd-side-${side}`);
      }
    }

    // Три кадра рядом: имя сверху, размер снизу — ровно как у GitHub.
    for (const [name, parts] of triplePlates) {
      parts.name.className = `ghpd-plate-label${
        name === 'diff' ? '' : ` ghpd-side-${name}`
      }`;
      parts.name.textContent = t(FRAMES[name]);
      parts.size.replaceChildren();
      if (name === 'diff') continue;
      const mine = name === 'after' ? result.after : result.before;
      const opposite = name === 'after' ? result.before : result.after;
      parts.size.append(
        ...frameSize({
          width: mine.naturalWidth,
          height: mine.naturalHeight,
          other: opposite && { width: opposite.naturalWidth, height: opposite.naturalHeight },
          units: { width: t('frameWidth'), height: t('frameHeight') },
        }),
      );
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
    // Сохранять есть что только в одиночном кадре: три кадра рядом лежат на
    // трёх холстах, и «эта картинка» перестаёт быть одной картинкой.
    save.disabled = !single;
  }

  cropToggle.addEventListener('click', () => {
    cropped = !cropped;
    render();
  });

  outlineToggle.addEventListener('click', () => {
    outline = !outline;
    settings.write(OUTLINE_KEY, outline);
    render();
  });

  // Настройка сравнения: язык, переключатель кадров, цвета и бета — всё то
  // же, что на странице настроек расширения. Разница одна: хранилища
  // расширения здесь нет, и выбор применяется сразу.
  const tune = {
    language: document.querySelector('#language'),
    views: document.querySelector('#show-views'),
    changed: document.querySelector('#color-changed'),
    lighter: document.querySelector('#color-lighter'),
    direction: document.querySelector('#direction'),
    directionColors: document.querySelector('#direction-colors'),
    reset: document.querySelector('#colors-reset'),
    beta: document.querySelector('#beta'),
  };

  /** Список языков — из самих локалей: написанный руками разойдётся с ними. */
  function fillLanguages() {
    const { languages, chosen } = global.GhPixelDiffLocale;
    const auto = el('option', null, t('optionsLanguageAuto'));
    auto.value = '';
    tune.language.replaceChildren(auto);
    for (const { code, name } of languages) {
      const option = el('option', null, name);
      option.value = code;
      tune.language.append(option);
    }
    tune.language.value = chosen();
  }

  /**
   * Переставляет надписи после смены языка.
   *
   * Перезагрузка была бы дешевле, но унесла бы с собой обе картинки: они
   * лежат в памяти, а не в адресе. Поэтому всё, что подписано один раз при
   * запуске, подписывается здесь заново; остальное скажет render().
   */
  function relabel() {
    label();
    fillLanguages();
    slider.setAttribute('aria-label', t('thresholdLabel'));
    slider.title = t('thresholdHint');
    canvas.title = t('zoomHint');
    save.textContent = t('saveFrame');
    showCropLabel = twoWayLabel(cropToggle, t('showFullFrame'), t('showChangesOnly'));
    const more = document.querySelector('.ghpd-menu-button');
    more.title = t('moreControls');
    more.setAttribute('aria-label', t('moreControls'));
    for (const [name, node] of viewButtons) node.textContent = t(FRAMES[name]);
    for (const [name, node] of tripleLabels) node.textContent = t(FRAMES[name]);
    for (const [button, key] of [[prevChange, 'clusterPrev'], [nextChange, 'clusterNext']]) {
      button.title = t(key);
      button.setAttribute('aria-label', t(key));
    }
    if (result) render();
  }

  fillLanguages();
  tune.language.addEventListener('change', () => {
    global.GhPixelDiffLocale.choose(tune.language.value);
    relabel();
  });

  /**
   * Показывать ли переключатель кадров.
   * Спрятанный переключатель не должен запирать в том кадре, который был
   * выбран до этого: из «3-up» иначе не выйти, и сохранение в нём погашено.
   */
  function applyViews(visible) {
    views.hidden = !visible;
    if (!visible && shownFrame !== 'diff') {
      shownFrame = 'diff';
      settings.write(FRAME_KEY, shownFrame);
      for (const [name, node] of viewButtons) {
        node.classList.toggle('selected', name === shownFrame);
        node.setAttribute('aria-pressed', String(name === shownFrame));
      }
      if (result) render();
    }
  }

  tune.views.checked = settings.read(VIEWS_KEY, true) !== false;
  applyViews(tune.views.checked);
  tune.views.addEventListener('change', () => {
    settings.write(VIEWS_KEY, tune.views.checked);
    applyViews(tune.views.checked);
  });

  function showColors() {
    tune.changed.value = colors.changed;
    tune.lighter.value = colors.lighter;
    tune.direction.checked = Boolean(colors.direction);
    tune.directionColors.hidden = !colors.direction;
  }

  /** Цвет запечён в маску, поэтому смена цвета — это пересчёт, а не отрисовка. */
  function saveColors() {
    colors.changed = tune.changed.value;
    colors.lighter = tune.lighter.value;
    colors.direction = tune.direction.checked;
    tune.directionColors.hidden = !colors.direction;
    settings.write(COLORS_KEY, colors);
    if (result) compare();
  }

  showColors();
  for (const input of [tune.changed, tune.lighter]) {
    // input[type=color] шлёт `input` на каждое движение в палитре и `change`
    // на закрытии: считаем по второму, иначе пересчёт идёт сотню раз.
    input.addEventListener('change', saveColors);
  }
  tune.direction.addEventListener('change', saveColors);
  tune.reset.addEventListener('click', () => {
    Object.assign(colors, global.GhPixelDiff.COLORS);
    showColors();
    settings.write(COLORS_KEY, colors);
    if (result) compare();
  });

  tune.beta.checked = beta;
  tune.beta.addEventListener('change', () => {
    beta = tune.beta.checked;
    settings.write(BETA_KEY, beta);
    if (result) compare();
  });

  /** Поток здоровается сам: молчание — повод считать в общем потоке. */
  function greet(worker) {
    return new Promise((resolve) => {
      const timer = setTimeout(stop, WORKER_TIMEOUT);
      function stop(ok) {
        clearTimeout(timer);
        worker.removeEventListener('message', hello);
        worker.removeEventListener('error', stop);
        if (ok !== true) worker.terminate();
        resolve(ok === true);
      }
      const hello = ({ data }) => stop(data?.type === 'hello');
      worker.addEventListener('message', hello);
      worker.addEventListener('error', stop);
    });
  }

  async function createWorker() {
    try {
      const worker = new Worker('worker-boot.js');
      return (await greet(worker)) ? worker : null;
    } catch {
      return null;
    }
  }

  /** Разговор с потоком: на каждый вопрос — свой ответ, по номеру. */
  function connect(worker) {
    const pending = new Map();
    let next = 0;
    worker.addEventListener('message', ({ data }) => {
      const waiting = pending.get(data.id);
      if (!waiting) return;
      pending.delete(data.id);
      data.type === 'error' ? waiting.reject(new Error(data.message)) : waiting.resolve(data);
    });
    worker.addEventListener('error', () => {
      for (const waiting of pending.values()) waiting.reject(new Error('worker'));
      pending.clear();
    });
    return (message, transfer = []) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...message, id }, transfer);
      });
  }

  /**
   * Готовит сравнение: раскладывает картинки по холстам и, если получилось,
   * отдаёт их потоку во владение. Делается один раз на пару: движение
   * ползунка меняет только порог.
   */
  async function start() {
    const pair = {
      before: files.before.url,
      after: files.after.url,
      // По blob:-адресу расширения не видно, поэтому тип приходит флагом.
      vector: files.before.vector || files.after.vector,
    };
    const prepared = await preparePair(pair);
    const worker = await createWorker();
    if (!worker) return { prepared, ask: null };

    const ask = connect(worker);
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
    document.documentElement.dataset.ghpdWorker = 'on';
    return { prepared, ask };
  }

  async function compare() {
    if (!files.before || !files.after) {
      panel.hidden = true;
      // Пока хоть одна половина пуста, объясняем это словами: пустая страница
      // под двумя рамками выглядит поломкой, а не ожиданием.
      failure.hidden = false;
      failure.textContent = t('siteNeedBoth');
      return;
    }

    const threshold = Number(slider.value);
    panel.hidden = false;
    failure.hidden = true;
    try {
      if (!session) {
        meta.textContent = t('computing');
        session = await start();
      }
      const computed = session.ask
        ? await session.ask({ type: 'diff', threshold, colors, beta })
        : diffPrepared(session.prepared, { threshold, colors, beta });

      result = { ...computed, before: session.prepared.before, after: session.prepared.after };
      // Из потока карта строк приходит буфером — собираем обратно.
      if (computed.rows instanceof ArrayBuffer) result.rows = new Int32Array(computed.rows);
      // Из потока разница приходит буфером — обратно в ImageData её собираем здесь.
      if (computed.mask instanceof ArrayBuffer) {
        result.mask = new ImageData(
          new Uint8ClampedArray(computed.mask),
          computed.width,
          computed.height,
        );
      }
      render();
    } catch (error) {
      // Отказ не запоминаем: следующая попытка должна начинаться с чистого листа.
      session = null;
      panel.hidden = true;
      failure.hidden = false;
      failure.textContent = t('failed', error.message) || error.message;
    }
  }

  let debounce = null;
  slider.addEventListener('input', () => {
    settings.write(THRESHOLD_KEY, Number(slider.value));
    clearTimeout(debounce);
    debounce = setTimeout(compare, SLIDER_DELAY);
  });

  const slotBox = (slot) => document.querySelector(`.drop[data-slot="${slot}"]`);

  /** Кладёт файл в половину и перезапускает сравнение. */
  function accept(slot, file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      failure.hidden = false;
      failure.textContent = t('siteNotImage', file.name || file.type);
      return;
    }

    // Прошлый адрес освобождаем: иначе каждая замена картинки оставляет
    // её копию в памяти вкладки до перезагрузки.
    if (files[slot]) URL.revokeObjectURL(files[slot].url);
    files[slot] = {
      url: URL.createObjectURL(file),
      name: file.name,
      vector: file.type === 'image/svg+xml',
    };

    const box = slotBox(slot);
    const preview = box.querySelector('.drop-preview');
    preview.src = files[slot].url;
    preview.hidden = false;
    // Размер пишем рядом с именем: по уменьшенному образцу его не угадать, а
    // на нём держится половина подписи под кадром.
    preview.addEventListener(
      'load',
      () => {
        box.querySelector('.drop-file').textContent =
          `${file.name} · ${preview.naturalWidth}×${preview.naturalHeight}`;
      },
      { once: true },
    );
    box.querySelector('.drop-file').textContent = file.name;
    box.querySelector('.drop-clear').hidden = false;
    box.classList.add('filled');

    // Пара сменилась — прежний расчёт больше не о ней, и увеличение тоже:
    // оно показывало место на прошлой картинке.
    session = null;
    result = null;
    zoom.reset();
    compare();
  }

  /** Убирает картинку из половины. */
  function clear(slot) {
    if (files[slot]) URL.revokeObjectURL(files[slot].url);
    files[slot] = null;

    const box = slotBox(slot);
    const preview = box.querySelector('.drop-preview');
    preview.hidden = true;
    preview.removeAttribute('src');
    box.querySelector('.drop-file').textContent = '';
    box.querySelector('.drop-clear').hidden = true;
    box.querySelector('input[type=file]').value = '';
    box.classList.remove('filled');

    session = null;
    result = null;
    compare();
  }

  for (const box of document.querySelectorAll('.drop')) {
    const slot = box.dataset.slot;
    const input = box.querySelector('input[type=file]');

    input.addEventListener('change', () => accept(slot, input.files[0]));
    box.querySelector('.drop-clear').addEventListener('click', () => clear(slot));

    for (const name of ['dragenter', 'dragover']) {
      box.addEventListener(name, (event) => {
        event.preventDefault();
        box.classList.add('over');
      });
    }
    for (const name of ['dragleave', 'drop']) {
      box.addEventListener(name, () => box.classList.remove('over'));
    }
    box.addEventListener('drop', (event) => {
      event.preventDefault();
      accept(slot, event.dataTransfer?.files?.[0]);
    });
  }

  document.querySelector('#reset').addEventListener('click', () => {
    clear('before');
    clear('after');
  });

  // Вставка из буфера: первая картинка идёт в «до», вторая в «после».
  document.addEventListener('paste', (event) => {
    const file = [...(event.clipboardData?.files ?? [])][0];
    if (!file) return;
    event.preventDefault();
    accept(files.before ? 'after' : 'before', file);
  });
})(self);
