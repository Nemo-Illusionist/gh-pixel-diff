// Отдельная страница: две картинки руками — та же разница, что во фрейме.
//
// Логика сравнения и отрисовки взята из расширения без изменений; здесь
// только оболочка: как картинки попадают внутрь и как выглядит панель.
(function (global) {
  'use strict';

  const { preparePair, diffPrepared } = global.GhPixelDiff;
  const { attachProbe, attachZoom, createZoom, drawCrop, frameFileName, holdStage, saveCanvas,
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

  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  document.documentElement.lang = global.__GHPD_LOCALE ?? 'en';
  document.title = `${t('siteTitle')} — ${t('modeName')}`;

  const panel = document.querySelector('#panel');
  const stage = document.querySelector('.panel-frame');
  const canvas = document.querySelector('#canvas');
  const triple = document.querySelector('#triple');
  const meta = document.querySelector('#meta');
  const failure = document.querySelector('#failure');
  const slider = document.querySelector('#threshold');
  const views = document.querySelector('#views');

  slider.setAttribute('aria-label', t('thresholdLabel'));
  slider.title = t('thresholdHint');

  // Холст с кадром целиком — один на страницу: заводить его заново на каждую
  // отрисовку значит тратить десятки мегабайт при каждом движении ползунка.
  const full = document.createElement('canvas');

  /** Что лежит в половинах и что из этого посчитано. */
  const files = { before: null, after: null };
  let session = null;
  let result = null;
  let shownFrame = 'diff';
  let cropped = true;
  let outline = true;

  const cropToggle = el('button', 'ghpd-crop-toggle');
  const outlineToggle = el('button', 'ghpd-outline-toggle');
  const zoomReset = el('button', 'ghpd-zoom-reset');
  cropToggle.type = 'button';
  outlineToggle.type = 'button';
  zoomReset.type = 'button';
  // Подписи у кнопки две, а ширина одна — по большей: иначе «весь кадр» и
  // «фрагмент» двигали бы всё, что правее, от нажатия к нажатию.
  const showCropLabel = twoWayLabel(cropToggle, t('showFullFrame'), t('showChangesOnly'));
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

  const tripleCanvases = ['before', 'after', 'diff'].map((name) => {
    const item = el('div', 'ghpd-triple-item');
    const target = el('canvas', 'ghpd-canvas');
    item.append(target, el('div', 'ghpd-triple-label', t(FRAMES[name])));
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
      box = drawCrop(canvas, full, result, { frame: shownFrame, cropped, outline, zoom, focus, colors: global.GhPixelDiff.COLORS });
      canvas.classList.toggle('ghpd-zoomed', zoom.scale > 1);
    } else {
      for (const [name, target] of tripleCanvases) {
        box = drawCrop(target, full, result, { frame: name, cropped, outline, focus, colors: global.GhPixelDiff.COLORS });
      }
    }

    holdStage(stage, single ? canvas : triple);

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
    render();
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
        ? await session.ask({ type: 'diff', threshold })
        : diffPrepared(session.prepared, { threshold });

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
