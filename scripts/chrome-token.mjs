// Выдача refresh-токена для публикации в Chrome Web Store.
//
// Ручной обмен кода на токен — самое ломкое место настройки: код одноразовый,
// живёт минуты, копируется из адресной строки, а без prompt=consent Google
// молча не возвращает refresh_token. Здесь всё это делается за один запуск.
//
// Поднимает слушателя на свободном порту, открывает согласие, ловит код,
// меняет его на токен и сразу кладёт три секрета в репозиторий: так значения
// нигде не всплывают — ни в переписке, ни в истории команд.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = 'Nemo-Illusionist/gh-pixel-diff';

// Ключи берём из файла, который выдала консоль Google: так секрет не проходит
// через терминал и не оседает в истории команд.
const path = process.argv[2];
if (!path) {
  console.error('Использование: node chrome-token.mjs <client_secret_….json>');
  process.exit(1);
}

const credentials = JSON.parse(await readFile(path, 'utf8'));
const { client_id: clientId, client_secret: clientSecret } =
  credentials.installed ?? credentials.web ?? {};

if (!clientId || !clientSecret) {
  console.error('В файле нет client_id и client_secret.');
  process.exit(1);
}

console.log(`Клиент: ${clientId}`);

// Порт занимать заранее нельзя: 8080 на машине разработчика занят почти
// всегда. Просим у системы свободный и уже из него собираем адрес возврата —
// клиентам типа Desktop Google разрешает любой локальный порт.
let redirect = '';

const code = await new Promise((resolve, reject) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, redirect);
    const value = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(value ? 'Готово, окно можно закрыть.' : `Отказано: ${error ?? 'нет кода'}`);
    server.close();
    value ? resolve(value) : reject(new Error(error ?? 'код не пришёл'));
  });
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    redirect = `http://localhost:${server.address().port}`;
    const consent =
      'https://accounts.google.com/o/oauth2/auth?response_type=code' +
      '&access_type=offline&prompt=consent' +
      '&scope=' + encodeURIComponent('https://www.googleapis.com/auth/chromewebstore') +
      '&redirect_uri=' + encodeURIComponent(redirect) +
      '&client_id=' + encodeURIComponent(clientId);
    console.log(`\nЖду ответа на ${redirect}`);
    console.log('Открываю согласие в браузере. Если не открылось — скопируйте:\n');
    console.log(consent + '\n');
    execFile('open', [consent], () => {});
  });
});

const answer = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  }),
});
const token = await answer.json();

if (!token.refresh_token) {
  console.error('\nТокен не выдан:', JSON.stringify(token, null, 2));
  process.exit(1);
}

for (const [name, value] of [
  ['CHROME_CLIENT_ID', clientId],
  ['CHROME_CLIENT_SECRET', clientSecret],
  ['CHROME_REFRESH_TOKEN', token.refresh_token],
]) {
  await run('gh', ['secret', 'set', name, '--repo', REPO, '--body', value]);
  console.log(`секрет ${name} — записан`);
}

console.log('\nГотово. Значения в репозитории, здесь их нет.');
