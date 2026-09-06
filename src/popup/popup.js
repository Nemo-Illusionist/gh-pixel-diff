// Выдача доступа к домену, на котором GitHub показывает картинки.
//
// Safari не распространяет разрешение для сайта на кросс-доменные фреймы, а
// viewscreen.githubusercontent.com в адресной строке никто не открывает —
// значит попросить доступ можно только отсюда, по нажатию.
const api = globalThis.browser ?? globalThis.chrome;
const ORIGINS = { origins: ['https://viewscreen.githubusercontent.com/*'] };

const status = document.querySelector('#status');
const grant = document.querySelector('#grant');

function show(granted) {
  status.classList.remove('status-checking');
  status.classList.toggle('status-granted', granted);
  status.classList.toggle('status-missing', !granted);
  status.textContent = granted
    ? 'Доступ есть — режим появится в панели просмотра картинок.'
    : 'Доступа нет: без него режим не появится.';
  grant.hidden = granted;
}

async function check() {
  try {
    show(await api.permissions.contains(ORIGINS));
  } catch (error) {
    status.textContent = `Не удалось проверить доступ: ${error.message}`;
  }
}

grant.addEventListener('click', async () => {
  try {
    const granted = await api.permissions.request(ORIGINS);
    show(granted);
    if (!granted) {
      status.textContent =
        'Доступ не выдан. Его же можно включить в настройках расширения, кнопкой «Изменить сайты».';
    }
  } catch (error) {
    status.textContent = `Не вышло: ${error.message}`;
  }
});

check();
