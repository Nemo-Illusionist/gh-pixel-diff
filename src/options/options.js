// Страница настроек: доступ к своим серверам GitLab.
//
// Адрес такого сервера в манифесте не назовёшь — их столько же, сколько
// компаний. Поэтому разрешение просится по нажатию, а скрипт регистрируется
// на лету. Фонового процесса ради этого заводить не нужно:
// scripting.registerContentScripts можно звать отсюда, и запись переживает
// перезапуск браузера.
const { api, t, translate, wireAccess, ORIGINS } = self.GhPixelDiffPage;
const { LANGUAGES, apply: applyLanguage, choose: chooseLanguage } = self.GhPixelDiffLocale;

const language = document.querySelector('#language');

/** Наполняет список языков и подписывает «как в браузере» на нынешнем языке. */
function fillLanguages(chosen) {
  language.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('optionsLanguageAuto');
  language.append(auto);
  for (const item of LANGUAGES) {
    const option = document.createElement('option');
    option.value = item.code;
    // Имя языка — на нём самом, и переводить его не нужно: так его узнают
    // и те, кто открыл настройки на чужом языке.
    option.textContent = item.name;
    language.append(option);
  }
  language.value = chosen;
}

/** Расставляет надписи страницы: после смены языка — заново. */
function retranslate(chosen) {
  translate();
  fillLanguages(chosen);
  document.documentElement.lang = chosen || navigator.language.slice(0, 2);
}

// Надписи ждут языка: выбранный вручную приезжает из хранилища, то есть не
// сразу, и расставить их раньше значит показать чужой язык и переписать.
applyLanguage()
  .catch(() => '')
  .then((chosen) => {
    retranslate(chosen);
    wireAccess(document.querySelector('#status'), document.querySelector('#grant'));
  });

language.addEventListener('change', () => {
  const chosen = language.value;
  // Строки для панелей раскладывает эта страница: файл локали доступен
  // только страницам расширения, а панель живёт на чужой.
  chooseLanguage(chosen)
    .then(() => retranslate(chosen))
    .catch(() => {
      language.value = '';
    });
});

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

/**
 * Два вида своих серверов — и чем они отличаются.
 *
 * `match` — по какой строке искать в манифесте состав скрипта: списки файлов
 * для GitLab и для фрейма GitHub разные, а переписывать их сюда руками значит
 * однажды разойтись с тем, что грузит браузер.
 *
 * У GitHub Enterprise скрипт работает во фреймах: картинки диффа рисуются в
 * отдельном окне внутри страницы, как и на github.com.
 */
const KINDS = {
  gitlab: { match: 'gitlab.com', allFrames: false },
  github: { match: 'viewscreen.githubusercontent.com', allFrames: true },
};

/**
 * Поддомен, на котором GitHub — и облачный, и свой — рисует превью файлов.
 *
 * У Enterprise с включённой изоляцией поддоменов это `viewscreen.<хост>`, без
 * неё превью приходит с самого хоста. Какой из случаев у человека, заранее
 * неизвестно, поэтому просим оба адреса сразу: лишнее разрешение здесь
 * дешевле, чем режим, который не появился и не объяснил почему.
 */
const VIEWSCREEN = 'viewscreen.';

/** Разметка обеих секций: у каждой свой вид сервера. */
const SECTIONS = {
  gitlab: {
    form: document.querySelector('#add'),
    input: document.querySelector('#host'),
    message: document.querySelector('#message'),
    list: document.querySelector('#hosts'),
    empty: document.querySelector('#empty'),
  },
  github: {
    form: document.querySelector('#add-github'),
    input: document.querySelector('#host-github'),
    message: document.querySelector('#message-github'),
    list: document.querySelector('#hosts-github'),
    empty: document.querySelector('#empty-github'),
  },
};

/** Имя записи в реестре скриптов: по нему же её и снимаем. */
const idFor = (kind, host) => `${kind}-${host}`;

/** Адреса, которые нужны этому виду сервера. */
const originsFor = (kind, origin, host) =>
  kind === 'github' ? [origin, origin.replace(`//${host}/`, `//${VIEWSCREEN}${host}/`)] : [origin];

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
function scriptsFor(kind) {
  const entry = api.runtime
    .getManifest()
    .content_scripts.find((script) => script.matches.some((match) => match.includes(KINDS[kind].match)));
  return { js: entry.js, css: entry.css };
}

const hostOf = (origin) => origin.replace(/^https?:\/\//, '').replace(/\/\*$/, '');

/** Адреса сверх тех, что выданы при установке. */
async function granted() {
  const { origins = [] } = await api.permissions.getAll();
  return origins.filter((origin) => !ORIGINS.origins.includes(origin));
}

/**
 * Какие серверы добавлены и какого они вида — по одним лишь разрешениям.
 *
 * Своего списка не заводим намеренно: разрешение отзывается и мимо этой
 * страницы, в настройках браузера, и список, который мы бы хранили, начал бы
 * врать в тот же день. Вид сервера виден по самим адресам: разрешение на
 * `viewscreen.<хост>` бывает только у GitHub Enterprise — у GitLab такого
 * поддомена нет.
 */
function describe(origins) {
  const hosts = new Map();
  for (const origin of origins) {
    const host = hostOf(origin);
    if (!host.startsWith(VIEWSCREEN)) hosts.set(host, { kind: 'gitlab', origins: [origin] });
  }
  for (const origin of origins) {
    const host = hostOf(origin);
    if (!host.startsWith(VIEWSCREEN)) continue;
    const parent = host.slice(VIEWSCREEN.length);
    const known = hosts.get(parent);
    if (known) hosts.set(parent, { kind: 'github', origins: [...known.origins, origin] });
    // Разрешение на превью есть, а на сам сервер нет: половина отозвана мимо
    // этой страницы. Показываем как есть — иначе адрес пропал бы из списка,
    // оставшись выданным.
    else hosts.set(parent, { kind: 'github', origins: [origin] });
  }
  return hosts;
}

function say(kind, text, bad) {
  const { message } = SECTIONS[kind];
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
async function sync(hosts) {
  if (!api.scripting?.registerContentScripts) return;

  const registered = await api.scripting.getRegisteredContentScripts();
  const ours = registered.filter((script) => /^(gitlab|github)-/.test(script.id));
  const wanted = new Map(
    [...hosts].map(([host, { kind, origins }]) => [idFor(kind, host), { kind, origins }]),
  );

  const stale = ours.filter((script) => !wanted.has(script.id));
  if (stale.length) {
    await api.scripting.unregisterContentScripts({ ids: stale.map((script) => script.id) });
  }

  const known = new Set(ours.map((script) => script.id));
  const missing = [...wanted].filter(([id]) => !known.has(id));
  if (missing.length) {
    await api.scripting.registerContentScripts(
      missing.map(([id, { kind, origins }]) => ({
        id,
        matches: origins,
        ...scriptsFor(kind),
        allFrames: KINDS[kind].allFrames,
        runAt: 'document_end',
      })),
    );
  }
}

async function remove(kind, host, origins) {
  try {
    // Сначала снимаем регистрацию: запись без разрешения браузеру не нужна.
    if (api.scripting?.unregisterContentScripts) {
      await api.scripting.unregisterContentScripts({ ids: [idFor(kind, host)] }).catch(() => {});
    }
    await api.permissions.remove({ origins });
    say(kind, null);
  } catch (error) {
    say(kind, t('optionsFailed'), true);
    console.error(error);
  }
  await render();
}

async function render() {
  const hosts = describe(await granted());
  try {
    await sync(hosts);
  } catch (error) {
    say('gitlab', t('optionsFailed'), true);
    console.error(error);
  }

  for (const [kind, section] of Object.entries(SECTIONS)) {
    section.list.replaceChildren();
    let shown = 0;
    for (const [host, entry] of hosts) {
      if (entry.kind !== kind) continue;
      shown++;
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = host;
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.textContent = t('optionsRemove');
      drop.addEventListener('click', () => remove(kind, host, entry.origins));
      item.append(name, drop);
      section.list.append(item);
    }
    section.empty.hidden = shown > 0;
  }
}

/** Добавление сервера: разрешение спрашивается здесь, по этому нажатию. */
function wireForm(kind) {
  const { form, input } = SECTIONS[kind];

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const { origin, host, error } = toOrigin(input.value);
    if (error) {
      say(kind, t(error), true);
      return;
    }

    // Регистрировать скрипт браузер даст только после того, как разрешение
    // выдано, — и попросить его можно лишь отсюда, по этому самому нажатию.
    if (!api.scripting?.registerContentScripts) {
      say(kind, t('optionsUnsupported'), true);
      return;
    }

    try {
      if (!(await api.permissions.request({ origins: originsFor(kind, origin, host) }))) {
        say(kind, t('optionsDenied'), true);
        return;
      }
    } catch (caught) {
      say(kind, t('optionsFailed'), true);
      console.error(caught);
      return;
    }

    input.value = '';
    await render();
    // Уже открытая вкладка своего скрипта не получит: регистрация действует
    // со следующей загрузки.
    say(kind, t('optionsAdded'));
  });
}

for (const kind of Object.keys(SECTIONS)) wireForm(kind);

render();
