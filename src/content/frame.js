// Встраивание в панель просмотра картинок GitHub.
//
// Превью бинарных файлов GitHub рисует в отдельном фрейме на своём домене:
// там лежат обе версии картинки и переключатель «2-up / Swipe / Onion Skin».
// Расширение добавляет к ним четвёртый режим — и работает по тем же правилам,
// что и родные: своя радиокнопка, свой контейнер `.view`, свой ползунок.
(function (global) {
  'use strict';

  const { diffPrepared, preparePair, readImagePair } = global.GhPixelDiff;
  const { plural, t } = global.GhPixelDiffI18n;

  const MODE = 'pixel-diff';
  const CROP_PADDING = 40;
  /** Порог pixelmatch: 0 — ловит даже сглаживание, 0.5 — только явные отличия. */
  const THRESHOLD_MAX = 0.5;
  const THRESHOLD_DEFAULT = 0.1;
  const THRESHOLD_KEY = 'ghpd:threshold';

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
  function readThreshold() {
    try {
      // Именно так: Number(null) — это ноль, и без проверки на пустоту порог
      // молча уезжал бы в самый левый край при первом же открытии.
      const stored = localStorage.getItem(THRESHOLD_KEY);
      const saved = Number(stored);
      if (stored !== null && Number.isFinite(saved) && saved >= 0 && saved <= THRESHOLD_MAX) {
        return saved;
      }
    } catch {
      // Приватный режим и запрет на хранилище — не повод падать.
    }
    return THRESHOLD_DEFAULT;
  }

  function saveThreshold(value) {
    try {
      localStorage.setItem(THRESHOLD_KEY, String(value));
    } catch {
      // См. выше.
    }
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
      saveThreshold(value);
      onChange(value);
    });

    controls.append(
      el('span', 'ghpd-mark ghpd-mark-small'),
      input,
      el('span', 'ghpd-mark ghpd-mark-large'),
    );

    return { element: controls, get value() { return Number(input.value); } };
  }

  function drawCrop(canvas, result, cropped) {
    const full = document.createElement('canvas');
    full.width = result.diff.width;
    full.height = result.diff.height;
    full.getContext('2d').putImageData(result.diff, 0, 0);

    if (!cropped || !result.bounds) {
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(full, 0, 0);
      // Кадр показывается уменьшенным, и несколько изменившихся пикселей на нём
      // просто исчезают. Поэтому обводим место, где они нашлись.
      if (result.bounds) {
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
    const frame = el('span', 'ghpd-frame');
    const canvas = el('canvas', 'ghpd-canvas');
    frame.append(canvas);

    const meta = el('p', 'ghpd-meta');
    const cropToggle = el('button', 'ghpd-crop-toggle');
    cropToggle.type = 'button';

    shell.append(frame, meta);
    view.append(shell);

    let result = null;
    let prepared = null;
    let loading = null;
    let cropped = true;

    const render = () => {
      const box = drawCrop(canvas, result, cropped);
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

    // Картинки грузятся и раскладываются по холстам ровно один раз: движение
    // ползунка меняет только порог, и пересчитывать ради него декодирование
    // снимка в несколько мегапикселей незачем.
    const compare = async (threshold) => {
      try {
        if (!prepared) {
          meta.textContent = t('computing');
          loading ??= preparePair(pair, { repository: repositoryFromUrl() });
          prepared = await loading;
        }
        result = diffPrepared(prepared, { threshold });
        render();
      } catch (error) {
        meta.textContent = t('failed', error.message);
      }
    };

    let debounce = null;
    const slider = createSlider((value) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => compare(value), 150);
    });
    view.append(slider.element);

    return {
      element: view,
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

    modes.addEventListener('change', sync);
    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})(self);
