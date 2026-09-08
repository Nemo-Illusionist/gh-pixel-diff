// Тексты берутся из тех же файлов, что и в расширении.
//
// i18n.js написан под chrome.i18n, и переписывать его ради страницы значит
// завести вторую копию, которая разойдётся с первой. Дешевле подставить сюда
// тот кусок API, которым он пользуется: две функции.
(function (global) {
  'use strict';

  const messages = global.__GHPD_MESSAGES ?? {};
  const language = (global.navigator?.language ?? 'en').toLowerCase();
  // Язык берём по первым двум буквам: ru-RU и ru — один и тот же перевод.
  const locale = messages[language.slice(0, 2)] ? language.slice(0, 2) : 'en';
  const strings = messages[locale] ?? {};

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

  global.chrome = { i18n: { getMessage, getUILanguage: () => locale } };
  global.__GHPD_LOCALE = locale;
})(self);
