// Отдельная страница: две картинки руками — та же разница, что во фрейме.
//
// Логика сравнения и отрисовки взята из расширения без изменений; здесь
// только оболочка: как картинки попадают внутрь и как выглядит панель.
(function (global) {
  'use strict';

  const { preparePair, diffPrepared } = global.GhPixelDiff;
  const { drawCrop } = global.GhPixelDiffRender;
  const { t, plural } = global.GhPixelDiffI18n;

  const FRAMES = { before: 'viewBefore', after: 'viewAfter', diff: 'viewDiff', triple: 'viewTriple' };
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
  cropToggle.type = 'button';
  outlineToggle.type = 'button';

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
      // Из потока разница приходит буфером — обратно в ImageData её собираем здесь.
      if (computed.diff instanceof ArrayBuffer) {
        result.diff = new ImageData(
          new Uint8ClampedArray(computed.diff),
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

    // Пара сменилась — прежний расчёт больше не о ней.
    session = null;
    result = null;
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
