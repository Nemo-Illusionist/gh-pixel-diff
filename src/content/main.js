// Встраивание в страницу GitHub.
//
// Сами картинки лежат в кросс-доменном iframe (viewscreen.githubusercontent.com),
// куда расширению не заглянуть. Но адреса обеих версий GitHub кладёт прямо в
// адрес этого iframe — оттуда их и берём, а панель вставляем рядом.
(function (global) {
  'use strict';

  const { readImagePair } = global.GhPixelDiff;
  const { createPanel } = global.GhPixelDiffUI;

  const MARK = 'ghpdReady';

  function mountFor(iframe) {
    if (iframe.dataset[MARK]) return;
    const pair = readImagePair(iframe.src);
    if (!pair) return;

    // Панель ставим перед блоком превью — так она не зависит от того,
    // как GitHub в очередной раз назовёт классы шапки файла.
    const host = iframe.closest('.render-wrapper') || iframe.parentElement;
    if (!host || !host.parentElement) return;

    iframe.dataset[MARK] = '1';
    host.parentElement.insertBefore(createPanel(pair), host);
  }

  function scan(root = document) {
    const frames = root.querySelectorAll?.('iframe[src*="viewscreen.githubusercontent.com/diff/img"]');
    if (frames) frames.forEach(mountFor);
  }

  // GitHub подгружает файлы по мере прокрутки и переключает страницы через Turbo,
  // поэтому одного прохода мало.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.('iframe[src*="viewscreen.githubusercontent.com/diff/img"]')) {
          mountFor(node);
        } else {
          scan(node);
        }
      }
    }
  });

  scan();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('turbo:load', () => scan());
  document.addEventListener('pjax:end', () => scan());
})(self);
