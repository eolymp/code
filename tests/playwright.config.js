const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 90000,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
});
