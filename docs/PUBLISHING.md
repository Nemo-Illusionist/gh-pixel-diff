# Публикация в магазины

Памятка сопровождающему. Разовую настройку делают руками — магазины требуют
живого человека с аккаунтом; дальше каждая новая версия уезжает на витрины
сама, по тегу.

## Как это работает после настройки

```
npm run release -- 0.8.0   →   ветка и пул-реквест с новой версией
       ↓ мёрж
git tag v0.8.0 && git push origin v0.8.0
       ↓
.github/workflows/release.yml     архивы на странице релизов
       ↓ needs: release
.github/workflows/publish.yml     Chrome Web Store и Firefox Add-ons
```

Каждая витрина включается своей переменной репозитория. Пока переменная не
задана, задание пропускается — это же спасает форки от попыток публиковать
что-то от чужого имени.

Если магазин отверг сборку и нужно повторить попытку без нового тега:
**Actions → Магазины → Run workflow**, выбрать тег.

---

## Chrome Web Store

### Разовая настройка

**1. Аккаунт разработчика — 5 $ один раз, навсегда.**
<https://chrome.google.com/webstore/devconsole>

**2. Первая загрузка — руками.** Автоматика умеет обновлять товар, но не
заводить его: у нового товара нет ни идентификатора, ни витрины.

```
npm run package        # архивы в dist/release
npm run screenshots    # витринные кадры 1280×800 в dist/store
```

Загрузить `dist/release/gh-pixel-diff-chrome-*.zip`, заполнить витрину
(тексты — в конце этой страницы), приложить кадры из `dist/store` и отправить
на проверку. Первая проверка занимает от нескольких часов до пары недель.

**3. Идентификатор товара.** Взять из адреса товара в консоли и положить в
переменную репозитория `CHROME_EXTENSION_ID` (Settings → Secrets and variables
→ Actions → Variables). Это не секрет: он виден в адресе магазина.

**4. Ключи доступа к API.**

1. <https://console.cloud.google.com> → создать проект.
2. APIs & Services → Library → включить **Chrome Web Store API**.
3. OAuth consent screen → тип **External**.
   **Важно:** перевести его в состояние **In production**. Пока приложение в
   состоянии Testing, Google протухает refresh-токен через семь дней, и
   публикация начнёт падать через неделю после настройки.
4. Credentials → Create credentials → OAuth client ID → тип **Desktop app**.
   Записать client ID и client secret.
5. Получить код: открыть в браузере, подставив свой client ID, и разрешить
   доступ. Код появится на странице.

   ```
   https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&redirect_uri=urn:ietf:wg:oauth:2.0:oob&client_id=ВАШ_CLIENT_ID
   ```

6. Обменять код на refresh-токен (код одноразовый и живёт минуты):

   ```
   curl -s https://oauth2.googleapis.com/token \
     -d client_id=ВАШ_CLIENT_ID \
     -d client_secret=ВАШ_CLIENT_SECRET \
     -d code=КОД_СО_СТРАНИЦЫ \
     -d grant_type=authorization_code \
     -d redirect_uri=urn:ietf:wg:oauth:2.0:oob
   ```

**5. Секреты репозитория:** `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`,
`CHROME_REFRESH_TOKEN`.

### Что делает автоматика

Заливает архив новой версией товара и нажимает «опубликовать». Ответ
`ITEM_PENDING_REVIEW` — нормальный: версия принята и ждёт проверки. Тексты и
кадры витрины автоматика не трогает — их правят руками, и они переживают
обновления.

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
