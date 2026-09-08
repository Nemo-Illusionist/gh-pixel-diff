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
  /** Цвет обводки — тот же, которым pixelmatch красит различия. */
  const OUTLINE_COLOR = '#d1242f';

  /**
   * Рисует выбранный кадр на холсте и возвращает показанный прямоугольник.
   *
   * @param canvas куда рисуем
   * @param full   вспомогательный холст с кадром целиком — один на всю
   *               панель: на снимке в несколько мегапикселей заводить его
   *               заново на каждую отрисовку значит тратить десятки мегабайт
   *               при каждом движении ползунка
   * @param result результат сравнения
   * @param cropped обрезать ли по изменениям
   * @param outline рисовать ли рамку вокруг найденного
   * @param shownFrame 'before' | 'after' | 'diff'
   */
  function drawCrop(canvas, full, result, cropped, outline, shownFrame) {
    full.width = result.width;
    full.height = result.height;
    const source = full.getContext('2d');
    if (shownFrame === 'diff') {
      source.putImageData(result.diff, 0, 0);
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
        ctx.strokeStyle = OUTLINE_COLOR;
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

  global.GhPixelDiffRender = { drawCrop, CROP_PADDING, OUTLINE_COLOR };
})(self);
