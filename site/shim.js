// Тексты берутся из тех же файлов, что и в расширении.
//
// i18n.js написан под chrome.i18n, и переписывать его ради страницы значит
// завести вторую копию, которая разойдётся с первой. Дешевле подставить сюда
// тот кусок API, которым он пользуется: две функции.
//
// Кладём их под своим именем, а не в window.chrome. То имя принадлежит
// браузеру, и там, где оно защищено от записи, присваивание в строгом режиме
// роняет весь этот файл — страница остаётся без единой надписи, молча.
//
// Язык — как в браузере или выбранный руками, как в расширении. Выбор живёт в
// localStorage: хранилища расширения на этой странице нет.
(function (global) {
  'use strict';

  const messages = global.__GHPD_MESSAGES ?? {};
  /** Выбранный язык; пусто — как в браузере. */
  const LANGUAGE_KEY = 'ghpd:language';

  /** Языки на выбор. Имя — на нём самом: так его узнают в любой локали. */
  const languages = Object.keys(messages)
    .sort()
    .map((code) => ({ code, name: messages[code]?.languageName?.message ?? code }));

  const read = () => {
    try {
      return global.localStorage?.getItem(LANGUAGE_KEY) ?? '';
    } catch {
      // Приватный режим, запрет на хранилище — язык берётся у браузера.
      return '';
    }
  };

  /** Язык браузера по первым двум буквам: ru-RU и ru — один и тот же перевод. */
  const fromBrowser = () => {
    const language = (global.navigator?.language ?? 'en').toLowerCase().slice(0, 2);
    return messages[language] ? language : 'en';
  };

  let locale = messages[read()] ? read() : fromBrowser();
  let strings = messages[locale] ?? {};

  function getMessage(key, substitutions = []) {
    const entry = strings[key];
    if (!entry) return '';
    let text = entry.message;
    for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
      const index = Number(placeholder.content.slice(1)) - 1;
      text = text.replaceAll(`$${name}$`, String(substitutions[index] ?? ''));
    }
    return text;
  }

  /**
   * Меняет язык страницы. Перезагрузка здесь была бы дешевле, но она унесла
   * бы с собой обе картинки: они лежат в памяти, а не в адресе. Поэтому
   * подменяем источник строк, а надписи переставляет тот, кто их ставил.
   * @param {string} code код языка или пустая строка — как в браузере.
   */
  function choose(code) {
    try {
      if (code) global.localStorage?.setItem(LANGUAGE_KEY, code);
      else global.localStorage?.removeItem(LANGUAGE_KEY);
    } catch {
      // Не сохранилось — на этой странице язык всё равно сменится.
    }
    locale = messages[code] ? code : fromBrowser();
    strings = messages[locale] ?? {};
    global.__GHPD_LOCALE = locale;
  }

  global.GhPixelDiffMessages = { getMessage, getUILanguage: () => locale };
  global.__GHPD_LOCALE = locale;
  global.GhPixelDiffLocale = {
    languages,
    /** Что выбрано руками; пусто — язык браузера. */
    chosen: () => (messages[read()] ? read() : ''),
    choose,
  };
})(self);
