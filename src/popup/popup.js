// Окно расширения: состояние доступа, переключатель кадров и ссылки.
//
// Всё редкое — на странице настроек: своими серверами GitLab занимаются раз
// в жизни, а окно открывают, чтобы выдать доступ и идти дальше.
const { api, translate, wireAccess } = self.GhPixelDiffPage;
const REPOSITORY = 'https://github.com/Nemo-Illusionist/gh-pixel-diff';

translate();

wireAccess(document.querySelector('#status'), document.querySelector('#grant'));

// Версия — здесь: в панели расширений её показывает не всякий браузер, а
// сравнить установленное с последним релизом хочется всегда.
const { version } = api.runtime.getManifest();
document.querySelector('#version').textContent = `v${version}`;

// В теле задачи — версия и браузер: без них первый вопрос всё равно про них.
document.querySelector('#report').href =
  `${REPOSITORY}/issues/new?body=` +
  encodeURIComponent(`\n\n---\n${version} · ${navigator.userAgent}`);

document.querySelector('#settings').addEventListener('click', (event) => {
  event.preventDefault();
  api.runtime.openOptionsPage();
});

// Переключатель кадров в панели: показывать или нет. По умолчанию да.
const showViews = document.querySelector('#show-views');

// Отказ хранилища не должен уносить с собой остальное окно: выше — кнопка
// выдачи доступа, ради которой окно и существует.
Promise.resolve(api.storage.sync.get({ showViews: true }))
  .then(({ showViews: value }) => {
    showViews.checked = value !== false;
  })
  .catch(() => {});

showViews.addEventListener('change', () => {
  Promise.resolve(api.storage.sync.set({ showViews: showViews.checked })).catch(() => {});
});
