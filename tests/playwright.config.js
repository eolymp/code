const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 90000,
  expect: { timeout: 20000 },
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  projects: [
    { name: 'first launch', testMatch: 'first-launch.spec.js' },
    { name: 'app', testMatch: '*.spec.js', testIgnore: 'first-launch.spec.js', dependencies: ['first launch'] },
  ],
});
