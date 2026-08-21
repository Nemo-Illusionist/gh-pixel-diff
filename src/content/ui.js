// Панель сравнения: кнопка, три режима просмотра и порог чувствительности.
(function (global) {
  'use strict';

  const { comparePair } = global.GhPixelDiff;

  const MODES = [
    { id: 'changes', label: 'Изменения' },
    { id: 'diff', label: 'Разница целиком' },
    { id: 'swipe', label: 'Шторка' },
    { id: 'side', label: 'Рядом' },
  ];

  /** Поле вокруг области изменений, чтобы было видно окружающий текст. */
  const CROP_PADDING = 40;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatCount(result) {
    const percent = result.ratio * 100;
    const shown = percent >= 0.01 ? percent.toFixed(2) : '<0.01';
    return `${result.changed.toLocaleString('ru-RU')} пикселей · ${shown}%`;
  }

  function drawImageData(canvas, imageData) {
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
  }

  /** Тот же diff, но обрезанный по области изменений. */
  function buildCrop(result) {
    const box = result.bounds;
    const x = Math.max(0, box.x - CROP_PADDING);
    const y = Math.max(0, box.y - CROP_PADDING);
    const width = Math.min(result.width - x, box.width + CROP_PADDING * 2);
    const height = Math.min(result.height - y, box.height + CROP_PADDING * 2);

    const full = document.createElement('canvas');
    drawImageData(full, result.diff);

    const canvas = el('canvas', 'ghpd-canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(full, x, y, width, height, 0, 0, width, height);

    const wrap = el('div', 'ghpd-crop');
    const note = el(
      'div',
      'ghpd-caption',
      `Фрагмент ${width}×${height} на позиции ${x}, ${y} — здесь уместились все различия.`,
    );
    wrap.append(canvas, note);
    return wrap;
  }

  /** Режим «Шторка»: обе версии друг на друге, граница тянется мышью. */
  function buildSwipe(result) {
    const wrap = el('div', 'ghpd-swipe');
    const after = el('img', 'ghpd-swipe-img');
    after.src = result.after.src;
    const beforeBox = el('div', 'ghpd-swipe-clip');
    const before = el('img', 'ghpd-swipe-img');
    before.src = result.before.src;
    beforeBox.append(before);
    const handle = el('div', 'ghpd-swipe-handle');
    wrap.append(after, beforeBox, handle);

    let position = 50;
    const apply = () => {
      beforeBox.style.width = `${position}%`;
      handle.style.left = `${position}%`;
    };
    apply();

    const move = (event) => {
      const rect = wrap.getBoundingClientRect();
      const x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
      position = Math.min(100, Math.max(0, (x / rect.width) * 100));
      apply();
    };
    const stop = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', stop);
    };
    const start = (event) => {
      event.preventDefault();
      move(event);
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', stop);
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('touchend', stop);
    };
    wrap.addEventListener('mousedown', start);
    wrap.addEventListener('touchstart', start, { passive: false });

    return wrap;
  }

  function buildSide(result) {
    const wrap = el('div', 'ghpd-side');
    for (const [image, caption] of [[result.before, 'До'], [result.after, 'После']]) {
      const cell = el('figure', 'ghpd-side-cell');
      const img = el('img', 'ghpd-side-img');
      img.src = image.src;
      cell.append(img, el('figcaption', 'ghpd-caption', caption));
      wrap.append(cell);
    }
    return wrap;
  }

  /** Собирает панель для одной пары картинок. */
  function createPanel(pair) {
    const panel = el('div', 'ghpd-panel');
    const bar = el('div', 'ghpd-bar');
    const button = el('button', 'ghpd-button', 'Пиксельная разница');
    button.type = 'button';
    const status = el('span', 'ghpd-status');
    bar.append(button, status);

    const body = el('div', 'ghpd-body ghpd-hidden');
    const tabs = el('div', 'ghpd-tabs');
    const canvas = el('canvas', 'ghpd-canvas');
    const stage = el('div', 'ghpd-stage');
    stage.append(canvas);

    const thresholdBox = el('label', 'ghpd-threshold');
    const thresholdInput = el('input');
    thresholdInput.type = 'range';
    thresholdInput.min = '0';
    thresholdInput.max = '0.5';
    thresholdInput.step = '0.01';
    thresholdInput.value = '0.1';
    const thresholdValue = el('span', 'ghpd-threshold-value', '0.10');
    thresholdBox.append(el('span', null, 'Порог'), thresholdInput, thresholdValue);

    body.append(tabs, stage, thresholdBox);
    panel.append(bar, body);

    let result = null;
    let mode = 'changes';
    let busy = false;

    const renderStage = () => {
      stage.replaceChildren();
      if (mode === 'changes' && result.bounds) {
        stage.append(buildCrop(result));
      } else if (mode === 'diff' || mode === 'changes') {
        drawImageData(canvas, result.diff);
        stage.append(canvas);
      } else if (mode === 'swipe') {
        stage.append(buildSwipe(result));
      } else {
        stage.append(buildSide(result));
      }
    };

    const renderTabs = () => {
      tabs.replaceChildren();
      for (const item of MODES) {
        // Обрезать нечего, если различий нет вовсе.
        if (item.id === 'changes' && !result?.bounds) continue;
        const tab = el('button', `ghpd-tab${item.id === mode ? ' ghpd-tab-active' : ''}`, item.label);
        tab.type = 'button';
        tab.addEventListener('click', () => {
          mode = item.id;
          renderTabs();
          renderStage();
        });
        tabs.append(tab);
      }
    };

    const compute = async (threshold) => {
      if (busy) return;
      busy = true;
      status.textContent = 'Считаю…';
      try {
        result = await comparePair(pair, { threshold });
        if (!result.bounds && mode === 'changes') mode = 'diff';
        status.textContent = formatCount(result);
        if (result.sizeChanged) {
          status.textContent += ` · размер изменился: ${result.before.naturalWidth}×${result.before.naturalHeight} → ${result.after.naturalWidth}×${result.after.naturalHeight}`;
        }
        renderTabs();
        renderStage();
        body.classList.remove('ghpd-hidden');
        button.textContent = 'Скрыть разницу';
      } catch (error) {
        status.textContent = `Не вышло: ${error.message}`;
      } finally {
        busy = false;
      }
    };

    button.addEventListener('click', () => {
      if (result && !body.classList.contains('ghpd-hidden')) {
        body.classList.add('ghpd-hidden');
        button.textContent = 'Пиксельная разница';
        return;
      }
      if (result) {
        body.classList.remove('ghpd-hidden');
        button.textContent = 'Скрыть разницу';
        return;
      }
      compute(Number(thresholdInput.value));
    });

    let debounce = null;
    thresholdInput.addEventListener('input', () => {
      thresholdValue.textContent = Number(thresholdInput.value).toFixed(2);
      if (!result) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => compute(Number(thresholdInput.value)), 150);
    });

    return panel;
  }

  global.GhPixelDiffUI = { createPanel };
})(self);
