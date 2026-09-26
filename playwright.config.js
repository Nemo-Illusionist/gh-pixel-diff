// @ts-check
import { defineConfig } from '@playwright/test';

// Два движка, а не один. Расширение живёт в Chrome, Firefox и Safari, и код
// у всех трёх общий — значит и проверять его надо не на одном.
//
// Тесты для этого ничего не грузят как расширение: они сами подкладывают
// `chrome` и вставляют те же файлы, что вставил бы браузер, — поэтому
// движок им безразличен.
//
// WebKit сюда пока не взят: он расходится с остальными на единицу в канале
// цвета при чтении холста, и половина проверок цвета падает не на деле, а на
// строгости сравнения. Разбираться с этим стоит отдельно.
export default defineConfig({
  testDir: './tests',
  forbidOnly: true,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
