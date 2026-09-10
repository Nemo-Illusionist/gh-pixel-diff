// Окно расширения: состояние доступа и ссылки. Всё остальное — в настройках.
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
