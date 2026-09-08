// Тексты интерфейса: английский по умолчанию, русский — если браузер русский.
//
// Строки лежат в _locales и подставляются через chrome.i18n. Вне расширения
// (на отдельной странице, в тестах) этого API нет — тогда источник строк
// подставляют снаружи под именем GhPixelDiffMessages. Своё имя, а не chrome:
// то занято браузером, и там, где оно защищено от записи, присваивание
// обрывает скрипт, а весь интерфейс остаётся без единой надписи.
// Если источника нет вовсе, вместо текста возвращается пустая строка, и
// вызывающий код решает сам.
(function (global) {
  'use strict';

  const i18n = global.GhPixelDiffMessages ?? (global.browser ?? global.chrome)?.i18n;

  /** Текст по ключу; подстановки — в порядке $1, $2, … */
  function t(key, ...substitutions) {
    return i18n?.getMessage(key, substitutions.map(String)) || '';
  }

  function locale() {
    return i18n?.getUILanguage?.() || global.navigator?.language || 'en';
  }

  /**
   * Множественное число словами языка интерфейса.
   * У русского форм три, у английского две — поэтому выбирает Intl, а ключи
   * («pixelsOne», «pixelsFew», …) есть ровно те, что нужны конкретному языку.
   */
  function plural(key, count) {
    const language = locale();
    const category = new Intl.PluralRules(language).select(count);
    const suffix = category[0].toUpperCase() + category.slice(1);
    const number = count.toLocaleString(language);
    return t(`${key}${suffix}`, number) || t(`${key}Other`, number) || String(number);
  }

  global.GhPixelDiffI18n = { t, plural, locale };
})(self);
