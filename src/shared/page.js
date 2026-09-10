// Надписи и доступ — общее у окна расширения и страницы настроек.
//
// Обе страницы просят у браузера одни и те же два адреса и показывают один и
// тот же ответ; расходиться этим текстам незачем, а править их в двух местах
// — способ однажды забыть про одно из них.
(function (global) {
  'use strict';

  const api = global.browser ?? global.chrome;

  const t = (key, ...substitutions) => api.i18n.getMessage(key, substitutions.map(String));

  /** Адреса, ради которых расширение и существует: они выданы при установке. */
  const ORIGINS = {
    origins: ['https://viewscreen.githubusercontent.com/*', 'https://gitlab.com/*'],
  };

  // Разметка держит только ключи: data-i18n — для обычного текста,
  // data-i18n-rich — для строк с <b> и <code>, которые в переводе остаются
  // частью фразы.
  //
  // Разметку из перевода собираем узлами, а не innerHTML: строка приходит из
  // файла локали, но присваивание innerHTML само по себе — замечание при
  // проверке дополнения, и обходиться без него дешевле, чем объяснять.
  const TAGS = /<(b|code)>(.*?)<\/\1>/g;

  function setRich(node, text) {
    node.replaceChildren();
    let cut = 0;
    for (const match of text.matchAll(TAGS)) {
      if (match.index > cut) node.append(text.slice(cut, match.index));
      const tag = document.createElement(match[1]);
      tag.textContent = match[2];
      node.append(tag);
      cut = match.index + match[0].length;
    }
    node.append(text.slice(cut));
  }

  /** Проставляет надписи по ключам в атрибутах. */
  function translate(root = document) {
    for (const node of root.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of root.querySelectorAll('[data-i18n-rich]')) {
      setRich(node, t(node.dataset.i18nRich));
    }
    for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    }
  }

  /**
   * Состояние доступа и кнопка его выдачи.
   *
   * Просить разрешение можно только по нажатию, и это единственная причина,
   * по которой у расширения вообще есть своё окно: Safari не распространяет
   * разрешение для сайта на кросс-доменные фреймы, а
   * viewscreen.githubusercontent.com в адресной строке никто не открывает.
   */
  function wireAccess(status, grant) {
    function show(granted) {
      status.classList.remove('status-checking');
      status.classList.toggle('status-granted', granted);
      status.classList.toggle('status-missing', !granted);
      status.textContent = granted ? t('popupGranted') : t('popupMissing');
      grant.hidden = granted;
    }

    grant.addEventListener('click', async () => {
      try {
        const granted = await api.permissions.request(ORIGINS);
        show(granted);
        if (!granted) status.textContent = t('popupDenied');
      } catch (error) {
        status.textContent = t('failed', error.message);
      }
    });

    api.permissions
      .contains(ORIGINS)
      .then(show)
      .catch((error) => {
        // Проверить не вышло — но выдать доступ, возможно, всё ещё можно.
        // Без кнопки пользователю остаётся только текст ошибки и тупик.
        status.classList.remove('status-checking');
        status.textContent = t('popupCheckFailed', error.message);
        grant.hidden = false;
      });
  }

  global.GhPixelDiffPage = { api, t, setRich, translate, wireAccess, ORIGINS };
})(self);
