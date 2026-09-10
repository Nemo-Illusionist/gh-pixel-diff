// Страница настроек: доступ к своим серверам GitLab.
//
// Адрес такого сервера в манифесте не назовёшь — их столько же, сколько
// компаний. Поэтому разрешение просится по нажатию, а скрипт регистрируется
// на лету. Фонового процесса ради этого заводить не нужно:
// scripting.registerContentScripts можно звать отсюда, и запись переживает
// перезапуск браузера.
const { api, t, translate, wireAccess, ORIGINS } = self.GhPixelDiffPage;

translate();
wireAccess(document.querySelector('#status'), document.querySelector('#grant'));

// Переключатель кадров в панели: показывать или нет. По умолчанию да.
// Он оказался удобнее, чем ожидалось, и выключают его редко — потому и здесь.
const showViews = document.querySelector('#show-views');

// Отказ хранилища не должен уносить с собой остальную страницу: ниже — то,
// ради чего её открывают.
Promise.resolve(api.storage.sync.get({ showViews: true }))
  .then(({ showViews: value }) => {
    showViews.checked = value !== false;
  })
  .catch(() => {});

showViews.addEventListener('change', () => {
  Promise.resolve(api.storage.sync.set({ showViews: showViews.checked })).catch(() => {});
});

const form = document.querySelector('#add');
const input = document.querySelector('#host');
const message = document.querySelector('#message');
const list = document.querySelector('#hosts');
const empty = document.querySelector('#empty');

/** Имя записи в реестре скриптов: по нему же её и снимаем. */
const idFor = (host) => `gitlab-${host}`;

/**
 * Адрес из того, что напечатал человек.
 *
 * Люди приносят сюда что угодно: с http, со схемой и без, со слэшем, с
 * портом, с целым путём до мердж-реквеста. Разбираем это URL-ом, а не
 * регуляркой, и возвращаем либо готовый шаблон, либо ключ ошибки.
 *
 * Порт из шаблона выпадает намеренно: шаблоны разрешений его не понимают, а
 * разрешение на хост и так покрывает все его порты.
 */
function toOrigin(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { error: 'optionsHostBad' };
  // Звёздочку не принимаем: попросить разрешение на «все сайты» человек
  // может и сам, в настройках браузера, но не через эту строку.
  if (value.includes('*')) return { error: 'optionsHostBad' };

  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { error: 'optionsHostBad' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'optionsHostBad' };

  const host = url.hostname;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return { error: 'optionsHostBad' };
  }
  // Эти адреса расширение знает с рождения: просить их ещё раз незачем.
  if (ORIGINS.origins.some((origin) => origin.startsWith(`${url.protocol}//${host}/`))) {
    return { error: 'optionsHostCovered' };
  }

  return { host, origin: `${url.protocol}//${host}/*` };
}

/** Состав скрипта берём из манифеста: второй список разошёлся бы с первым. */
function gitlabScripts() {
  const entry = api.runtime
    .getManifest()
    .content_scripts.find((script) => script.matches.some((match) => match.includes('gitlab.com')));
  return { js: entry.js, css: entry.css };
}

const hostOf = (origin) => origin.replace(/^https?:\/\//, '').replace(/\/\*$/, '');

/** Адреса сверх тех, что выданы при установке. */
async function granted() {
  const { origins = [] } = await api.permissions.getAll();
  return origins.filter((origin) => !ORIGINS.origins.includes(origin));
}

function say(text, bad) {
  message.textContent = text ?? '';
  message.hidden = !text;
  message.classList.toggle('message-bad', Boolean(bad));
}

/**
 * Сверяет реестр скриптов с выданными разрешениями.
 *
 * Разрешение можно отозвать мимо этой страницы — в настройках браузера, и
 * тогда регистрация останется висеть. Источник правды один: то, что говорит
 * permissions, а не то, что мы когда-то записали.
 */
async function sync(origins) {
  if (!api.scripting?.registerContentScripts) return;

  const registered = await api.scripting.getRegisteredContentScripts();
  const ours = registered.filter((script) => script.id.startsWith('gitlab-'));

  const stale = ours.filter((script) => !origins.includes(script.matches?.[0]));
  if (stale.length) {
    await api.scripting.unregisterContentScripts({ ids: stale.map((script) => script.id) });
  }

  const known = new Set(ours.map((script) => script.matches?.[0]));
  const missing = origins.filter((origin) => !known.has(origin));
  if (missing.length) {
    const { js, css } = gitlabScripts();
    await api.scripting.registerContentScripts(
      missing.map((origin) => ({
        id: idFor(hostOf(origin)),
        matches: [origin],
        js,
        css,
        runAt: 'document_end',
      })),
    );
  }
}

async function remove(origin) {
  try {
    // Сначала снимаем регистрацию: запись без разрешения браузеру не нужна.
    if (api.scripting?.unregisterContentScripts) {
      await api.scripting
        .unregisterContentScripts({ ids: [idFor(hostOf(origin))] })
        .catch(() => {});
    }
    await api.permissions.remove({ origins: [origin] });
    say(null);
  } catch (error) {
    say(t('optionsFailed'), true);
    console.error(error);
  }
  await render();
}

async function render() {
  const origins = await granted();
  try {
    await sync(origins);
  } catch (error) {
    say(t('optionsFailed'), true);
    console.error(error);
  }

  list.replaceChildren();
  for (const origin of origins) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = hostOf(origin);
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.textContent = t('optionsRemove');
    drop.addEventListener('click', () => remove(origin));
    item.append(name, drop);
    list.append(item);
  }
  empty.hidden = origins.length > 0;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const { origin, error } = toOrigin(input.value);
  if (error) {
    say(t(error), true);
    return;
  }

  // Регистрировать скрипт браузер даст только после того, как разрешение
  // выдано, — и попросить его можно лишь отсюда, по этому самому нажатию.
  if (!api.scripting?.registerContentScripts) {
    say(t('optionsUnsupported'), true);
    return;
  }

  try {
    if (!(await api.permissions.request({ origins: [origin] }))) {
      say(t('optionsDenied'), true);
      return;
    }
  } catch (caught) {
    say(t('optionsFailed'), true);
    console.error(caught);
    return;
  }

  input.value = '';
  await render();
  // Уже открытая вкладка своего скрипта не получит: регистрация действует со
  // следующей загрузки.
  say(t('optionsAdded'));
});

render();
