const { defineConfig } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

// Tests run against a throwaway database so they never touch real bookings or accounts.
const dataDir = path.join(os.tmpdir(), `nasha-test-${Date.now()}`);

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
  },
  webServer: { command: 'node serve.mjs', url: 'http://127.0.0.1:4173', env: { PORT: '4173', DATA_DIR: dataDir, ADMIN_PASSWORD: 'test-owner-password' }, reuseExistingServer: false },
});
