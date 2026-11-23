const { test, expect } = require('./app');

test.use({ files: { 'sum/sum.cpp': 'int main() {}\n' } });

test('A fresh editor shows only the views a beginner needs', async ({ editor }) => {
  const sidebar = editor.window.getByRole('tablist', { name: 'Active View Switcher' });
  await expect(sidebar.getByRole('tab', { name: /^Practice/ })).toBeVisible();
  await expect(sidebar.getByRole('tab', { name: /^Explorer/ })).toBeVisible();
  await expect(sidebar.getByRole('tab', { name: /^Source Control/ })).toHaveCount(0);
  await expect(editor.window.getByRole('button', { name: /^Accounts/ })).toHaveCount(0);

  await editor.toolbar.getByRole('button', { name: /^Test/ }).click();
  const panel = editor.window.locator('.part.panel .composite-bar');
  await expect(panel.getByRole('tab', { name: /^Console/ })).toBeVisible();
  await expect(panel.getByRole('tab', { name: /^Terminal/ })).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveCount(2);
});
