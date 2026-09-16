// Отрисовка кадра: общая для расширения и для отдельной страницы.
//
// Живёт отдельно от frame.js намеренно. Панель во фрейме GitHub и страница,
// куда картинки приносят руками, — разные оболочки вокруг одного и того же:
// вписать кадр, обрезать его по изменениям, обвести найденное. Две копии
// этого кода разошлись бы на первой же правке.
(function (global) {
  'use strict';

  /** Запас вокруг изменений при обрезке: правку удобнее видеть в контексте. */
  const CROP_PADDING = 40;
  /**
   * Цвет обводки — янтарный, не красный и не синий.
   *
   * Красный и синий теперь заняты смыслом: ими покрашено само изменение.
   * Рамка — не данные, а указатель, и путать её с находкой нельзя. Янтарный
   * различим и рядом с красным, и рядом с синим, в том числе при дальтонизме.
   */
  const OUTLINE_COLOR = '#bf8700';
  /** Насколько бледной становится подложка под разницей. */
  const UNDERLAY_ALPHA = 0.35;
  /** Насколько бледнее рамки вокруг тех мест, которые сейчас не выбраны. */
  const OTHER_OUTLINE_ALPHA = 0.4;
  /**
   * Предел увеличения. Шестнадцать — это когда пиксель кадра занимает на
   * экране заметный квадрат: дальше смотреть уже не на что, а промахнуться
   * мимо нужного места становится легко.
   */
  const ZOOM_MAX = 16;
  /** Шаг увеличения: одно нажатие «+», один щелчок колеса. */
  const ZOOM_STEP = 1.25;
  /** Колесо отдаёт пиксели прокрутки — переводим их в множитель. */
  const WHEEL_SPEED = 0.0025;
  /** Насколько увеличивает двойной щелчок — сразу к разглядыванию пикселей. */
  const ZOOM_DOUBLE = 4;
  /** Шаг стрелок: доля показанного куска. */
  const PAN_STEP = 0.2;

  /**
   * Холст под маску — один на всё расширение.
   *
   * Маска приходит из сравнения как ImageData, а положить её поверх подложки
   * можно только через drawImage: putImageData заменяет пиксели вместе с
   * прозрачностью, вместо того чтобы смешивать. Промежуточный холст нужен
   * ровно для этого перевода, живёт он доли миллисекунды и на панель не
   * ссылается, поэтому и общий: на странице GitLab таких панелей десяток.
   */
  let scratch = null;

  function maskCanvas(mask, width, height) {
    scratch ??= document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    scratch.getContext('2d').putImageData(mask, 0, 0);
    return scratch;
  }

  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  /**
   * Прямоугольник, который занимал бы кадр без увеличения.
   *
   * В обрезке это выбранное место изменений, а не общий прямоугольник:
   * когда правки в разных концах кадра, общий — это весь кадр, и обрезать
   * по нему нечего. Пока место одно, разницы никакой.
   */
  function baseRect(result, cropped, focus) {
    const box = focus ?? result.bounds;
    if (!cropped || !box) {
      return { x: 0, y: 0, width: result.width, height: result.height };
    }
    const x = Math.max(0, box.x - CROP_PADDING);
    const y = Math.max(0, box.y - CROP_PADDING);
    return {
      x,
      y,
      width: Math.min(result.width - x, box.width + CROP_PADDING * 2),
      height: Math.min(result.height - y, box.height + CROP_PADDING * 2),
    };
  }

  /**
   * Какой кусок кадра показываем при нынешнем увеличении.
   *
   * Увеличение не меняет размер холста: холст всегда размером с кадр без
   * увеличения, а внутрь него вписывается кусок поменьше. Иначе рост
   * увеличения уменьшал бы холст в пикселях — и картинка на экране, где
   * размер коробки берётся из этих пикселей, вместо приближения съёживалась
   * бы.
   *
   * Ходим только внутри базового прямоугольника: в режиме обрезки увеличение
   * разглядывает найденное, а не уводит из него. Нужен весь кадр — есть
   * переключатель.
   */
  function shownRect(base, zoom) {
    const scale = zoom?.scale ?? 1;
    if (!(scale > 1)) return base;
    const width = base.width / scale;
    const height = base.height / scale;
    const centreX = zoom.x ?? base.x + base.width / 2;
    const centreY = zoom.y ?? base.y + base.height / 2;
    return {
      x: clamp(centreX - width / 2, base.x, base.x + base.width - width),
      y: clamp(centreY - height / 2, base.y, base.y + base.height - height),
      width,
      height,
    };
  }

  /**
   * Рисует выбранный кадр на холсте и возвращает показанный прямоугольник.
   *
   * @param canvas куда рисуем
   * @param full   вспомогательный холст с кадром целиком — один на всю
   *               панель: на снимке в несколько мегапикселей заводить его
   *               заново на каждую отрисовку значит тратить десятки мегабайт
   *               при каждом движении ползунка
   * @param result результат сравнения
   * @param view   что показываем: { frame, cropped, outline, zoom, focus }.
   *               frame — 'before' | 'after' | 'diff' | 'overlay';
   *               focus — выбранное место изменений, если их несколько
   */
  function drawCrop(canvas, full, result, view) {
    const { cropped, outline, zoom, focus } = view;
    const shownFrame = view.frame;
    full.width = result.width;
    full.height = result.height;
    const source = full.getContext('2d');
    if (shownFrame === 'diff' || shownFrame === 'overlay') {
      // Разница и наложение — одна и та же маска на разной подложке. Под
      // разницей — обесцвеченное и бледное «до»: фон нужен только чтобы
      // понимать, где на кадре мы находимся. Под наложением — настоящее
      // «после» в цвете: правку видно в её собственном окружении, а не на
      // сером призраке.
      source.save();
      if (shownFrame === 'diff') {
        source.fillStyle = '#ffffff';
        source.fillRect(0, 0, result.width, result.height);
        source.globalAlpha = UNDERLAY_ALPHA;
        source.filter = 'grayscale(1)';
      }
      const under = result[shownFrame === 'diff' ? 'before' : 'after'];
      source.drawImage(
        under,
        0,
        0,
        under.naturalWidth * result.scale,
        under.naturalHeight * result.scale,
      );
      source.restore();
      source.drawImage(maskCanvas(result.mask, result.width, result.height), 0, 0);
    } else {
      // «До» и «после» рисуем в том же размере, что и разницу: у вектора это
      // увеличенный кадр, и переключение не должно менять масштаб.
      const image = result[shownFrame];
      source.clearRect(0, 0, result.width, result.height);
      source.drawImage(
        image,
        0,
        0,
        image.naturalWidth * result.scale,
        image.naturalHeight * result.scale,
      );
    }

    const base = baseRect(result, cropped, focus);
    const shown = shownRect(base, zoom);
    // Тот, кто ловит колесо и перетаскивание, должен знать, что сейчас под
    // курсором. Знает это только здесь — значит отсюда и говорим.
    if (zoom) zoom.seen(base, shown);

    canvas.width = base.width;
    canvas.height = base.height;
    const ctx = canvas.getContext('2d');
    // При увеличении сглаживание — враг: разглядывают именно пиксель, а не
    // его размытую догадку. Без увеличения оно, наоборот, нужно.
    ctx.imageSmoothingEnabled = shown.width >= canvas.width;
    ctx.drawImage(
      full,
      shown.x,
      shown.y,
      shown.width,
      shown.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    // Кадр показывается уменьшенным, и несколько изменившихся пикселей на нём
    // просто исчезают. Поэтому обводим место, где они нашлись — если рамка
    // не мешает: на мелком снимке она закрывает половину кадра. В обрезанном
    // кадре рамки нет: там и так видно только изменение.
    if (!cropped && result.bounds && outline) {
      const margin = Math.max(6, Math.round(Math.max(result.width, result.height) / 120));
      const factor = canvas.width / shown.width;
      const line = Math.max(2, Math.round(Math.max(result.width, result.height) / 400));
      // Мест изменений может быть несколько, и обвести надо все: иначе
      // переход «дальше» уводит туда, где на кадре ничего не отмечено.
      // Выбранное — в полную силу, остальные бледнее: видно и где мы сейчас,
      // и что есть ещё.
      const boxes = result.clusters?.length ? result.clusters : [result.bounds];
      ctx.save();
      // Рамка живёт в координатах кадра; увеличение переносит её сюда тем же
      // преобразованием, что и картинку.
      ctx.scale(factor, factor);
      ctx.translate(-shown.x, -shown.y);
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = line / factor;
      for (const box of boxes) {
        ctx.globalAlpha = !focus || box === focus ? 1 : OTHER_OUTLINE_ALPHA;
        ctx.strokeRect(
          box.x - margin,
          box.y - margin,
          box.width + margin * 2,
          box.height + margin * 2,
        );
      }
      ctx.restore();
    }

    return base;
  }

  /**
   * Состояние увеличения: во сколько раз и вокруг какой точки кадра.
   *
   * Центр держим в пикселях кадра, а не в долях холста: обрезка меняет
   * базовый прямоугольник, и доля в нём после переключения указывала бы
   * совсем на другое место картинки.
   *
   * @param onChange что позвать, когда увеличение изменилось: перерисовку
   */
  function createZoom(onChange) {
    return {
      scale: 1,
      x: null,
      y: null,
      /** Что показано сейчас — заполняет drawCrop. */
      base: null,
      shown: null,
      seen(base, shown) {
        this.base = base;
        this.shown = shown;
      },
      reset() {
        if (this.scale === 1 && this.x === null) return;
        this.scale = 1;
        this.x = null;
        this.y = null;
        onChange();
      },
      /**
       * Меняет увеличение, оставляя точку кадра под курсором на месте.
       *
       * @param factor во сколько раз изменить
       * @param anchor {x, y} в пикселях кадра; без неё — вокруг центра
       */
      by(factor, anchor) {
        const next = clamp(this.scale * factor, 1, ZOOM_MAX);
        if (next === this.scale) return;
        const shown = this.shown;
        if (next === 1) {
          this.scale = 1;
          this.x = null;
          this.y = null;
        } else if (anchor && shown) {
          // Доля, на которой точка стоит в показанном куске, сохраняется;
          // из неё и нового размера куска и получается новый центр.
          const partX = (anchor.x - shown.x) / shown.width;
          const partY = (anchor.y - shown.y) / shown.height;
          const width = (this.base?.width ?? shown.width) / next;
          const height = (this.base?.height ?? shown.height) / next;
          this.scale = next;
          this.x = anchor.x - (partX - 0.5) * width;
          this.y = anchor.y - (partY - 0.5) * height;
        } else {
          const shownNow = shown ?? this.base;
          this.scale = next;
          if (shownNow) {
            this.x = shownNow.x + shownNow.width / 2;
            this.y = shownNow.y + shownNow.height / 2;
          }
        }
        onChange();
      },
      /** Наводит увеличение на прямоугольник кадра; без увеличения — ничего. */
      lookAt(box) {
        if (this.scale === 1 || !box) return;
        this.x = box.x + box.width / 2;
        this.y = box.y + box.height / 2;
      },
      /** Сдвигает показанный кусок на столько пикселей кадра. */
      panBy(dx, dy) {
        if (this.scale === 1 || !this.shown) return;
        this.x = this.shown.x + this.shown.width / 2 + dx;
        this.y = this.shown.y + this.shown.height / 2 + dy;
        onChange();
      },
      /** Точка кадра под указателем. */
      at(event, canvas) {
        const box = canvas.getBoundingClientRect();
        const shown = this.shown;
        if (!shown || !box.width || !box.height) return null;
        return {
          x: shown.x + ((event.clientX - box.left) / box.width) * shown.width,
          y: shown.y + ((event.clientY - box.top) / box.height) * shown.height,
        };
      },
    };
  }

  /**
   * Вешает на холст колесо, перетаскивание, двойной щелчок и клавиши.
   *
   * Колесо берём только с Ctrl или ⌘ — и потому, что щипок на трекпаде
   * приходит браузеру именно так, и потому, что кадр живёт посреди страницы:
   * отнимать у человека обычную прокрутку ради увеличения нечестно.
   */
  function attachZoom(canvas, zoom) {
    // Холст становится остановкой табуляции: увеличение должно быть доступно
    // и без мыши — иначе им не воспользуется тот, кому оно нужнее всех.
    canvas.tabIndex = 0;

    canvas.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoom.by(Math.exp(-event.deltaY * WHEEL_SPEED), zoom.at(event, canvas));
    }, { passive: false });

    canvas.addEventListener('dblclick', (event) => {
      if (zoom.scale > 1) {
        zoom.reset();
        return;
      }
      zoom.by(ZOOM_DOUBLE, zoom.at(event, canvas));
    });

    let dragging = null;
    canvas.addEventListener('pointerdown', (event) => {
      if (zoom.scale === 1 || event.button !== 0) return;
      dragging = { x: event.clientX, y: event.clientY, id: event.pointerId };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('ghpd-panning');
      event.preventDefault();
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!dragging || event.pointerId !== dragging.id) return;
      const box = canvas.getBoundingClientRect();
      const shown = zoom.shown;
      if (!shown || !box.width) return;
      // Тянут картинку, а не окошко: кусок едет навстречу движению руки.
      zoom.panBy(
        -((event.clientX - dragging.x) / box.width) * shown.width,
        -((event.clientY - dragging.y) / box.height) * shown.height,
      );
      dragging.x = event.clientX;
      dragging.y = event.clientY;
    });

    const stopDrag = (event) => {
      if (!dragging || event.pointerId !== dragging.id) return;
      dragging = null;
      canvas.classList.remove('ghpd-panning');
    };
    canvas.addEventListener('pointerup', stopDrag);
    canvas.addEventListener('pointercancel', stopDrag);

    canvas.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const shown = zoom.shown;
      const step = (part) => (shown ? part : 0);
      switch (event.key) {
        case '+':
        case '=':
          zoom.by(ZOOM_STEP);
          break;
        case '-':
        case '_':
          zoom.by(1 / ZOOM_STEP);
          break;
        case '0':
          zoom.reset();
          break;
        case 'ArrowLeft':
          zoom.panBy(-step(shown.width * PAN_STEP), 0);
          break;
        case 'ArrowRight':
          zoom.panBy(step(shown.width * PAN_STEP), 0);
          break;
        case 'ArrowUp':
          zoom.panBy(0, -step(shown.height * PAN_STEP));
          break;
        case 'ArrowDown':
          zoom.panBy(0, step(shown.height * PAN_STEP));
          break;
        default:
          return;
      }
      event.preventDefault();
    });
  }

  /**
   * Сохраняет показанный кадр картинкой.
   *
   * Сохраняем именно холст, а не пересобранный кадр: на экране уже выбрано
   * всё, что нужно, — какой кадр, обрезка, увеличение, рамки. Человек просит
   * «вот эту картинку», а не «что-нибудь похожее».
   *
   * Холст не «грязный»: чужие картинки загружаются с CORS, свои и так со
   * своего домена. Иначе toBlob отказал бы — и это единственный случай, когда
   * сохранение не сработает, поэтому отказ сообщаем вызывающему.
   */
  function saveCanvas(canvas, name, onError) {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          onError?.();
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        // Ссылка должна быть в документе: в Firefox нажатие на оторванный от
        // документа элемент ничего не скачивает.
        document.body.append(link);
        link.click();
        link.remove();
        // Адрес держит blob в памяти вкладки, пока его не отпустят; ждать
        // конца загрузки не нужно — браузер уже взял данные себе.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }, 'image/png');
    } catch {
      onError?.();
    }
  }

  /**
   * Имя файла: от имени самой картинки, с приписанным видом кадра.
   * `shot.png` в режиме разницы станет `shot.diff.png` — по имени видно и
   * откуда это, и что именно на нём.
   */
  function frameFileName(source, frame) {
    const base =
      String(source ?? '')
        .split(/[?#]/)[0]
        .split('/')
        .pop()
        .replace(/\.[^.]+$/, '') || 'pixel-diff';
    return `${base}.${frame}.png`;
  }

  /**
   * Холст на один пиксель — им читаются цвета под курсором.
   *
   * Читать приходится из самих картинок: обе версии кадра отданы потоку
   * сравнения во владение, и в основном потоке их пикселей больше нет.
   * Рисовать ради одного цвета кадр целиком — это десятки мегабайт на каждое
   * движение мыши, поэтому картинка сдвигается так, чтобы нужная точка
   * попала в единственный пиксель холста.
   */
  let probeCanvas = null;

  function samplePixel(image, x, y, scale) {
    probeCanvas ??= document.createElement('canvas');
    probeCanvas.width = 1;
    probeCanvas.height = 1;
    const ctx = probeCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    ctx.drawImage(
      image,
      -x,
      -y,
      image.naturalWidth * scale,
      image.naturalHeight * scale,
    );
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a };
  }

  /** Цвет строкой: «#f85149», как его пишут в любом редакторе. */
  function hex({ r, g, b }) {
    return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
  }

  /**
   * Показывает под кадром, что за пиксель под курсором и каким он был.
   *
   * Разница отвечает «здесь изменилось», но не «на что»: красное пятно не
   * говорит, какой оттенок был до правки и какой стал. Один и тот же вопрос —
   * «а это точно тот самый серый?» — иначе решается пипеткой в стороннем
   * редакторе.
   *
   * @param canvas   кадр, по которому водят курсором
   * @param node     куда писать; его высота держится постоянной, иначе кадр
   *                 подпрыгивал бы при каждом входе курсора
   * @param zoom     состояние увеличения: оно знает, какой кусок кадра виден
   * @param getResult откуда брать нынешнее сравнение
   */
  function attachProbe(canvas, node, zoom, getResult) {
    const t = (key, ...rest) => global.GhPixelDiffI18n?.t(key, ...rest) || '';

    const clear = () => node.replaceChildren();

    const swatch = (color) => {
      const box = document.createElement('span');
      box.className = 'ghpd-probe-swatch';
      box.style.background = hex(color);
      return box;
    };

    canvas.addEventListener('pointermove', (event) => {
      const result = getResult();
      const point = result && zoom.at(event, canvas);
      if (!point) {
        clear();
        return;
      }
      const x = Math.floor(point.x);
      const y = Math.floor(point.y);
      if (x < 0 || y < 0 || x >= result.width || y >= result.height) {
        clear();
        return;
      }

      let before;
      let after;
      try {
        before = samplePixel(result.before, x, y, result.scale);
        after = samplePixel(result.after, x, y, result.scale);
      } catch {
        // «Грязный» холст — единственная причина отказа; молчим, а не ломаем
        // панель: инспектор здесь не главное.
        clear();
        return;
      }

      node.replaceChildren(
        `${x}, ${y} · `,
        swatch(before),
        ` ${t('viewBefore')} ${hex(before)} → `,
        swatch(after),
        ` ${t('viewAfter')} ${hex(after)}`,
      );
    });

    // Курсор ушёл — показывать нечего; строка остаётся на месте пустой, чтобы
    // кадр не прыгал.
    canvas.addEventListener('pointerleave', clear);
  }

  /** Как показать увеличение человеку: «2,5×», а не «2.4999999×». */
  function zoomLabel(scale, locale) {
    return `${Number(scale.toFixed(1)).toLocaleString(locale ?? 'en')}×`;
  }

  global.GhPixelDiffRender = {
    drawCrop,
    saveCanvas,
    frameFileName,
    attachProbe,
    createZoom,
    attachZoom,
    zoomLabel,
    CROP_PADDING,
    OUTLINE_COLOR,
    ZOOM_MAX,
  };
})(self);
