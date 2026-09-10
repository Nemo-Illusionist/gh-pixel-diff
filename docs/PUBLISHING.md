# Публикация в магазины

Памятка сопровождающему. Разовую настройку делают руками — магазины требуют
живого человека с аккаунтом; дальше каждая новая версия уезжает на витрины
сама, по тегу.

## Как это работает после настройки

```
коммиты вида feat: / fix: в main
       ↓
release-please держит открытым пул-реквест «chore: release X.Y.Z»
       ↓ Close → Reopen на нём, чтобы пошли проверки
       ↓ мёрж
тег и релиз создаются сами, дальше в том же запуске:
       архивы на странице релизов
       Chrome Web Store и Firefox Add-ons
```

Каждая витрина включается своей переменной репозитория. Пока переменная не
задана, задание пропускается — это же спасает форки от попыток публиковать
что-то от чужого имени.

Если магазин отверг сборку и нужно повторить попытку без новой версии:
**Actions → Магазины → Run workflow**, выбрать тег.

---

## Chrome Web Store

### Разовая настройка

**1. Аккаунт разработчика — 5 $ один раз, навсегда.**
<https://chrome.google.com/webstore/devconsole>

**2. Первая загрузка — руками.** Автоматика умеет обновлять товар, но не
заводить его: у нового товара нет ни идентификатора, ни витрины.

```
npm run screenshots    # витринные кадры 1280×800 в docs/store
npm run package        # архивы в dist/release
```

Загрузить `dist/release/gh-pixel-diff-chrome-*.zip`, заполнить витрину
(тексты — в конце этой страницы), приложить кадры из `docs/store` и отправить
на проверку. Первая проверка занимает от нескольких часов до пары недель.

**3. Идентификатор товара.** Взять из адреса товара в консоли и положить в
переменную репозитория `CHROME_EXTENSION_ID` (Settings → Secrets and variables
→ Actions → Variables). Это не секрет: он виден в адресе магазина.

**4. Ключи доступа к API.**

1. <https://console.cloud.google.com> → создать проект.
2. APIs & Services → Library → включить **Chrome Web Store API**.
3. OAuth consent screen (в новой консоли — Google Auth Platform → **Branding**
   и **Audience**) → тип **External**. Заполнить название и почту поддержки;
   блок **App domain** оставить пустым — иначе Google потребует подтвердить
   владение `github.com` через Search Console, а это невозможно.
4. **Data Access** → добавить область `https://www.googleapis.com/auth/chromewebstore`.
   Google кладёт её в **sensitive scopes** — не пугайтесь, проверку проходить
   не нужно, см. ниже.
5. **Branding** → заполнить **Application home page** и **Application privacy
   policy link**, а в **Authorized domains** добавить домен, на котором они
   лежат. Без ссылки на политику кнопка **Publish app** не разблокируется.

   У нас это `nemo-illusionist.github.io` — страница
   `.../gh-pixel-diff/privacy.html`. Домен на `github.io` Google принимает без
   подтверждения через Search Console; `github.com` добавить не даст, поэтому
   ссылаться на `docs/PRIVACY.md` в репозитории здесь нельзя.

   Логотип на этой же странице лучше убрать: загруженный логотип требует
   верификации бренда при переводе в production, а без него ничего подавать не
   нужно.
6. **Audience** → **Publish app**, чтобы перевести приложение в состояние
   **In production**.

   **Важно.** Пока приложение в **Testing**, Google протухает refresh-токен
   через семь дней, и публикация начнёт падать через неделю после настройки.
   Пока приложение в Testing, экран согласия пускает только тех, кто внесён в
   **Test users** — включая владельца проекта. Это годится как временная мера,
   но не как решение.

   После перевода в production консоль повесит баннер «Your app requires
   verification»: область магазина считается чувствительной. Подавать на
   проверку не нужно — экран согласия у неверифицированного приложения
   проходится через **Advanced → Go to … (unsafe)**, а согласие здесь даёт
   один человек, владелец товара, один раз в жизни. Верификация нужна лишь для
   того, чтобы этот экран не пугал посторонних; посторонних тут нет.
7. **Clients** → **Create OAuth client** → тип **Desktop app**. Консоль
   предложит скачать JSON с ключами — он и нужен дальше; посмотреть секрет
   второй раз она не даст.
8. Получить refresh-токен:

   ```
   npm run chrome:token -- ~/Downloads/client_secret_….json
   ```

   Скрипт поднимет слушателя на свободном порту, откроет согласие, поймает
   код, обменяет его и сам положит все три секрета в репозиторий через `gh` —
   значения не проходят через терминал и не оседают в истории команд.

   Тем же руками, если понадобится разобраться. Способ через
   `urn:ietf:wg:oauth:2.0:oob` больше не работает: Google закрыл его в 2022-м, и новый клиент ответит
   `invalid_request`. Клиентам типа Desktop разрешён возврат на локальный
   адрес — на нём и строится обмен:

   ```
   https://accounts.google.com/o/oauth2/auth?response_type=code&access_type=offline&prompt=consent&scope=https://www.googleapis.com/auth/chromewebstore&redirect_uri=http://localhost:8080&client_id=ВАШ_CLIENT_ID
   ```

   Браузер перекинет на `http://localhost:8080/?code=…` и покажет ошибку —
   страницы там нет, код берётся из адресной строки. Дальше обменять его
   (код одноразовый и живёт минуты):

   ```
   curl -s https://oauth2.googleapis.com/token \
     -d client_id=ВАШ_CLIENT_ID \
     -d client_secret=ВАШ_CLIENT_SECRET \
     -d code=КОД_ИЗ_АДРЕСНОЙ_СТРОКИ \
     -d grant_type=authorization_code \
     -d redirect_uri=http://localhost:8080
   ```

   `prompt=consent` обязателен: без него Google при повторной выдаче вернёт
   только access-токен, а `refresh_token` молча не пришлёт.

**9. Секреты репозитория:** `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`,
`CHROME_REFRESH_TOKEN`.

**10. Обоснования разрешений.** Витрина → **Privacy practices**. Каждое
разрешение из манифеста требует объяснения; тексты — в конце этой страницы.

### Что делает автоматика

Заливает архив новой версией товара и нажимает «опубликовать». Ответ
`ITEM_PENDING_REVIEW` — нормальный: версия принята и ждёт проверки. Тексты и
кадры витрины автоматика не трогает — их правят руками, и они переживают
обновления.

### Товар занят проверкой

```
"uploadState": "FAILURE",
"itemError": [{ "error_detail": "The item cannot be updated now because it is
in pending review, ready to publish, or deleted status." }]
```

Магазин держит один черновик на товар: пока предыдущая версия на проверке,
новую он не примет. Флага «поверх» в API нет.

Выхода два. Дождаться конца проверки и повторить выкладку без нового тега —
**Actions → Магазины → Run workflow**, выбрать тег. Либо отменить проверку:
консоль разработчика → страница товара → **⋮** → **Cancel review**; товар
вернётся в черновик, и следующая выкладка пройдёт. Отменять можно до шести
раз в сутки на издателя, и ускорения проверки это не даёт — только право
подсунуть версию посвежее.

Ошибка эта тем вероятнее, чем чаще релизы: проверка идёт часами, а тег можно
поставить за минуту.

---

## Firefox Add-ons

### Разовая настройка

**1. Аккаунт — бесплатно.** <https://addons.mozilla.org/developers/>

**2. Первая подача — руками.** Загрузить
`dist/release/gh-pixel-diff-firefox-*.zip` как **listed** дополнение и
заполнить витрину. Идентификатор дополнения зашит в сборку
(`scripts/build.mjs`), поэтому дальше AMO узнаёт наши версии сам.

Исходники отдельно прикладывать не нужно: код не минифицируется и не
собирается — что в архиве, то и написано.

**3. Ключи:** Manage API Keys → JWT issuer и JWT secret → секреты
`AMO_API_KEY` и `AMO_API_SECRET`.

**4. Включатель:** переменная репозитория `PUBLISH_AMO` = `true`.

### Что делает автоматика

`web-ext sign --channel listed` отправляет новую версию. Ждать подписи мы не
просим (`--approval-timeout 0`): витринные дополнения проверяют люди, и это
занимает от часов до суток. Задание зелёное — значит версия принята.

---

## Safari

Остаётся ручным: App Store требует платного аккаунта Apple (99 $ в год) и
проекта Xcode. Способ установки описан в README и в `SAFARI-INSTALL.txt`
внутри архива.

---

## Обоснования разрешений

Chrome Web Store → витрина товара → **Privacy practices**. Спрашивают про
каждое разрешение из манифеста; здесь — то, что вписано, чтобы не сочинять
заново.

**`storage`**

```
Remembers the comparison threshold, whether the changed area is outlined,
which frame was shown last, and whether the before / after / diff switcher is
visible. Settings only — no user data, no page content, nothing about the
images themselves.
```

**`scripting`**

```
Self-hosted GitLab lives at an address that cannot be known in advance and so
cannot be listed in the manifest. When the user adds such an address on the
settings page and grants access to it, the extension registers its own,
already shipped GitLab content script for that one host with
scripting.registerContentScripts. No code is fetched or injected from
anywhere else, and nothing runs on hosts the user has not added.
```

**Host permissions** (`viewscreen.githubusercontent.com`, `gitlab.com`)

```
GitHub renders image diffs inside a frame on viewscreen.githubusercontent.com
and GitLab renders them on gitlab.com. The extension adds its comparison mode
to that viewer and reads the two images the site has already loaded. It has no
access to github.com pages at all.
```

**Broad host permissions** (необязательные, `*://*/*`)

```
Never requested on install and never requested by the extension on its own.
The pattern exists only so that the user can name their own GitLab server on
the settings page; the browser then asks about that single host. Access is
revoked from the same page or from Chrome's extension settings.
```

**Remote code** — нет: всё, что выполняется, лежит в пакете.

---

## Тексты витрины

Одни и те же для обоих магазинов. Язык основной — английский.

**Название**

```
GitHub Pixel Diff
```

**Краткое описание** (Chrome — до 132 знаков, AMO — до 250)

```
Adds a pixel-level image diff to GitHub's image viewer — next to 2-up, Swipe and Onion Skin.
```

**Полное описание**

```
GitHub's image viewer shows you two pictures. It does not show you what
changed between them.

Pixel Diff adds a fourth mode next to 2-up, Swipe and Onion Skin. It compares
the two images pixel by pixel, paints every difference red, and crops the
result to the area that actually changed — so a three-pixel shift in a long
screenshot is a three-pixel shift you can see, not a picture you have to hunt
through.

- A threshold slider: raise it to ignore compression noise, lower it to catch
  everything.
- Before / after / diff, and all three side by side, sharing one scale and one
  crop.
- Images that changed size are aligned and compared anyway.
- SVG and other vector images are rasterised before comparison.
- Works on the images GitHub already loaded — nothing is uploaded anywhere.

The comparison runs in your browser, in a background thread. The extension has
no server, collects nothing, and sends nothing.

Open source: https://github.com/Nemo-Illusionist/gh-pixel-diff
```

**Категория:** Developer Tools (Chrome) · Developer tools (AMO)

**Политика конфиденциальности:**
`https://github.com/Nemo-Illusionist/gh-pixel-diff/blob/main/docs/PRIVACY.md`

### Ответы на вопросы Chrome о разрешениях

Их спрашивают на вкладке Privacy, и без них товар не отправить.

**Single purpose**

```
Comparing the two images shown in GitHub's image diff viewer, pixel by pixel,
and displaying the difference.
```

**storage**

```
Stores the user's own settings: the comparison threshold, whether the outline
around changes is drawn, which frame was shown last, and whether the
before/after/diff switcher is visible. No user data of any kind is stored.
```

**Host permission — https://viewscreen.githubusercontent.com/***

```
This is the frame GitHub renders image diffs in. The extension adds its mode to
that viewer and reads the two images already loaded there in order to compare
them. It runs nowhere else.
```

**Remote code:** No — everything the extension executes ships inside the
package. The comparison thread is built from files bundled with the extension.

**Data usage:** ни одна из категорий не отмечается; все три подтверждения
внизу страницы — да.
