// Сравнение в отдельном потоке.
//
// Снимок страницы легко занимает несколько мегапикселей, и pixelmatch на нём
// считается заметное время. В общем потоке это подвешивает фрейм: ползунок не
// двигается, кнопки не нажимаются. Здесь же поток свой, а обе картинки
// переданы сюда во владение — в основном потоке их копий больше нет.
(function (global) {
  'use strict';

  const { diffPrepared } = global.GhPixelDiff;

  let prepared = null;

  global.onmessage = ({ data }) => {
    if (data.type === 'prepare') {
      prepared = {
        width: data.width,
        height: data.height,
        scale: data.scale,
        sizeChanged: data.sizeChanged,
        // Вид поверх переданного буфера, без копирования.
        dataBefore: new ImageData(new Uint8ClampedArray(data.before), data.width, data.height),
        dataAfter: new ImageData(new Uint8ClampedArray(data.after), data.width, data.height),
      };
      global.postMessage({ type: 'ready' });
      return;
    }

    if (data.type === 'diff') {
      const result = diffPrepared(prepared, { threshold: data.threshold });
      global.postMessage(
        {
          type: 'diff',
          id: data.id,
          width: result.width,
          height: result.height,
          scale: result.scale,
          changed: result.changed,
          ratio: result.ratio,
          bounds: result.bounds,
          sizeChanged: prepared.sizeChanged,
          diff: result.diff.data.buffer,
        },
        [result.diff.data.buffer],
      );
    }
  };
})(self);
