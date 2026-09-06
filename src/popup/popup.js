// Выдача доступа к домену, на котором GitHub показывает картинки.
//
// Safari не распространяет разрешение для сайта на кросс-доменные фреймы, а
// viewscreen.githubusercontent.com в адресной строке никто не открывает —
// значит попросить доступ можно только отсюда, по нажатию.
const api = globalThis.browser ?? globalThis.chrome;
const ORIGINS = { origins: ['https://viewscreen.githubusercontent.com/*'] };
const REPOSITORY = 'https://github.com/Nemo-Illusionist/gh-pixel-diff';

const t = (key, ...substitutions) => api.i18n.getMessage(key, substitutions.map(String));

// Разметка держит только ключи: data-i18n — для обычного текста, data-i18n-rich —
// для строк с <b> и <code>, которые в переводе остаются частью фразы.
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

for (const node of document.querySelectorAll('[data-i18n]')) {
  node.textContent = t(node.dataset.i18n);
}
for (const node of document.querySelectorAll('[data-i18n-rich]')) {
  setRich(node, t(node.dataset.i18nRich));
}

const status = document.querySelector('#status');
const grant = document.querySelector('#grant');
const report = document.querySelector('#report');

// Версия — здесь: в панели расширений её показывает не всякий браузер, а
// сравнить установленное с последним релизом хочется всегда.
const { version } = api.runtime.getManifest();
document.querySelector('#version').textContent = `v${version}`;

// В теле задачи — версия и браузер: без них первый вопрос всё равно про них.
report.href =
  `${REPOSITORY}/issues/new?body=` +
  encodeURIComponent(`\n\n---\n${version} · ${navigator.userAgent}`);

// Переключатель кадров в панели: показывать или нет. По умолчанию да.
const showViews = document.querySelector('#show-views');

// Отказ хранилища не должен уносить с собой остальное окно: ниже — кнопка
// выдачи доступа, ради которой окно и существует.
Promise.resolve(api.storage.sync.get({ showViews: true }))
  .then(({ showViews: value }) => {
    showViews.checked = value !== false;
  })
  .catch(() => {});

showViews.addEventListener('change', () => {
  Promise.resolve(api.storage.sync.set({ showViews: showViews.checked })).catch(() => {});
});

function show(granted) {
  status.classList.remove('status-checking');
  status.classList.toggle('status-granted', granted);
  status.classList.toggle('status-missing', !granted);
  status.textContent = granted ? t('popupGranted') : t('popupMissing');
  grant.hidden = granted;
}

async function check() {
  try {
    show(await api.permissions.contains(ORIGINS));
  } catch (error) {
    // Проверить не вышло — но выдать доступ, возможно, всё ещё можно.
    // Без кнопки пользователю остаётся только текст ошибки и тупик.
    status.classList.remove('status-checking');
    status.textContent = t('popupCheckFailed', error.message);
    grant.hidden = false;
  }
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

check();
