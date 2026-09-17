// Поток сравнения: общий для всех страниц, где живёт панель.
//
// Расширение не может создать Worker прямо со своего адреса: страница другого
// происхождения. Поэтому исходники читаются через fetch и склеиваются в blob.
// Так это работает и во фрейме GitHub, и на странице GitLab — код один.
(function (global) {
  'use strict';

  const api = global.browser ?? global.chrome;

  /** Сколько ждём ответа от потока, прежде чем считать сами. */
  const WORKER_TIMEOUT = 5000;
  /** Из чего склеивается поток: порядок важен, каждый следующий ждёт предыдущего. */
  const SOURCES = ['vendor/pixelmatch.js', 'content/compare.js', 'content/worker.js'];

  /**
   * Заводит поток для сравнения.
   *
   * Собираем его из тех же файлов, что и content script: расширение не может
   * создать Worker прямо со своего адреса — страница другого происхождения, —
   * поэтому исходники читаются через fetch и склеиваются в blob. Если это не
   * вышло (нет chrome.runtime, запрещён blob), считаем в общем потоке: медленнее,
   * но работает.
   */
  async function createWorker() {
    if (!api?.runtime?.getURL || typeof Worker !== 'function') return null;
    try {
      const sources = await Promise.all(
        SOURCES.map(async (path) => {
          const response = await fetch(api.runtime.getURL(path));
          // Без этой проверки страница-заглушка вместо файла склеилась бы в
          // рабочий с виду blob, и провал вылез бы вечным «Считаю…».
          if (!response.ok) throw new Error(`${path}: ${response.status}`);
          return response.text();
        }),
      );
      const url = URL.createObjectURL(new Blob(sources, { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      await greet(worker);
      return worker;
    } catch {
      return null;
    }
  }

  /**
   * Ждёт, пока поток отзовётся.
   *
   * Отдельный шаг до передачи картинок: буферы уходят во владение и обратно не
   * возвращаются, поэтому убедиться, что поток жив, нужно раньше. Не отозвался
   * за отведённое время — считаем в общем потоке, картинки при этом целы.
   */
  function greet(worker) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(new Error('worker is silent')), WORKER_TIMEOUT);
      const hello = ({ data }) => {
        if (data?.type === 'hello') stop(null);
      };
      const failed = (event) => stop(new Error(event.message || 'worker error'));
      function stop(error) {
        clearTimeout(timer);
        worker.removeEventListener('message', hello);
        worker.removeEventListener('error', failed);
        if (!error) return resolve();
        worker.terminate();
        reject(error);
      }
      worker.addEventListener('message', hello);
      worker.addEventListener('error', failed);
    });
  }

  /**
   * Разговор с потоком: один слушатель на всё время жизни вместо слушателя на
   * каждый запрос — иначе за сотню движений ползунка их накапливается сотня.
   */
  function connect(worker) {
    const pending = new Map();
    let counter = 0;

    worker.addEventListener('message', ({ data }) => {
      const waiting = pending.get(data?.id);
      if (!waiting) return;
      pending.delete(data.id);
      if (data.type === 'error') waiting.reject(new Error(data.message));
      else waiting.resolve(data);
    });

    // Поток умер — отвечать некому: отпускаем всех, кто ждёт.
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'worker error');
      for (const waiting of pending.values()) waiting.reject(error);
      pending.clear();
    });

    // transfer — то, что уходит во владение: буферы картинок копировать
    // незачем, ради этого поток и заводился.
    return (message, transfer = []) =>
      new Promise((resolve, reject) => {
        const id = ++counter;
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...message, id }, transfer);
      });
  }


  /**
   * Заводит поток и налаживает с ним разговор.
   * @returns {Promise<{worker: Worker, ask: Function}|null>} null — считать
   *          придётся в общем потоке: медленнее, но работает.
   */
  async function create() {
    const worker = await createWorker();
    return worker ? { worker, ask: connect(worker) } : null;
  }

  global.GhPixelDiffWorker = { create };
})(self);
