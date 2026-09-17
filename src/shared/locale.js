// Язык интерфейса: как в браузере или выбранный вручную.
//
// Обычно язык расширения задаёт браузер, и chrome.i18n отвечает строками той
// локали, которую он выбрал. Но браузер на английском и работа на русском
// уживаются в одной голове сплошь и рядом, а переключателя языка у браузера
// для одного расширения нет. Поэтому выбор живёт здесь.
//
// Как это устроено. Выбранный язык — в хранилище `sync`, чтобы переезжал
// вместе с профилем. Сами строки — в `local`, и кладёт их туда страница
// настроек: содержимое `_locales` доступно только страницам расширения, а
// встроенным в чужие страницы скриптам — нет, и дотянуться до файла локали
// из панели сравнения нельзя. Зато до хранилища — можно.
(function (global) {
  'use strict';

  const api = global.browser ?? global.chrome;

  /** Языки на выбор. Имя — на нём самом: так его узнают в любой локали. */
  const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'ru', name: 'Русский' },
  ];

  /** Выбранный язык; пусто — как в браузере. */
  const LANGUAGE_KEY = 'ghpd:language';
  /** Строки выбранного языка, положенные страницей настроек. */
  const MESSAGES_KEY = 'ghpd:messages';

  /**
   * Источник строк поверх готового файла локали.
   *
   * Ключа может не оказаться: строки в хранилище от прошлой версии
   * расширения, а панель уже новая. Тогда отвечает браузер — на своём языке,
   * но со смыслом, а это лучше пустоты на месте надписи.
   */
  function fromMessages(messages, language) {
    return {
      getMessage(key, substitutions = []) {
        const entry = messages[key];
        if (!entry) return api?.i18n?.getMessage(key, substitutions) ?? '';
        let text = entry.message;
        for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
          const index = Number(placeholder.content.slice(1)) - 1;
          text = text.replaceAll(`$${name}$`, String(substitutions[index] ?? ''));
        }
        return text;
      },
      getUILanguage: () => language,
    };
  }

  /** Что выбрано; пустая строка — ничего, язык берётся у браузера. */
  async function chosen() {
    try {
      const stored = await api.storage.sync.get({ [LANGUAGE_KEY]: '' });
      return stored?.[LANGUAGE_KEY] || '';
    } catch {
      return '';
    }
  }

  /**
   * Ставит выбранный язык источником строк — до того, как их начнут просить.
   * @returns код языка или пустую строку, если выбора нет
   */
  async function apply() {
    const language = await chosen();
    if (!language) return '';
    try {
      const stored = await api.storage.local.get({ [MESSAGES_KEY]: null });
      const kept = stored?.[MESSAGES_KEY];
      // Строки от другого языка — не строки: язык успели сменить, а сюда
      // дошла только половина. Лучше браузерные, чем чужие.
      if (kept?.language === language) {
        global.GhPixelDiffMessages = fromMessages(kept.messages, language);
      }
    } catch {
      // Хранилища нет — остаётся язык браузера.
    }
    return language;
  }

  /**
   * Запоминает выбор и раскладывает строки для панелей.
   * Зовётся только со страницы настроек: только ей доступен файл локали.
   */
  async function choose(language) {
    await api.storage.sync.set({ [LANGUAGE_KEY]: language });
    if (!language) {
      global.GhPixelDiffMessages = null;
      await api.storage.local.remove(MESSAGES_KEY);
      return;
    }
    const response = await fetch(api.runtime.getURL(`_locales/${language}/messages.json`));
    const messages = await response.json();
    global.GhPixelDiffMessages = fromMessages(messages, language);
    await api.storage.local.set({ [MESSAGES_KEY]: { language, messages } });
  }

  global.GhPixelDiffLocale = { LANGUAGES, LANGUAGE_KEY, MESSAGES_KEY, apply, choose, chosen };
})(self);
